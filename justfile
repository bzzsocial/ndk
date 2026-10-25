# bzz fork of NDK. One file, no `mod` imports: each group is a single recipe
# that takes its first argument as a subcommand. Run `just` for the list.
#
# The workspace keeps the upstream @nostr-dev-kit names so merges from
# upstream stay clean. Only the copies published to npm are renamed to
# @bzzsocial/ndk and @bzzsocial/cache-dexie, with their built imports and
# peer dependencies pointing at @bzzsocial/ndk.
#
# Releasing: `just bump <pkg>`, add the CHANGELOG section, merge into `bzz`.
# The publish workflow then runs `just publish run` and `just release`.

set quiet := true
set shell := ["bash", "-uc"]
set positional-arguments := true

root := justfile_directory()

# Show this list
default:
    just --list --unsorted

# Build the packages: [all|core|cache-dexie]
build *args:
    #!/usr/bin/env bash
    set -euo pipefail
    case "${1:-all}" in
      all) pkgs="core cache-dexie" ;;
      core|cache-dexie) pkgs="$1" ;;
      *) echo "usage: just build {all|core|cache-dexie}" >&2; exit 1 ;;
    esac
    for pkg in $pkgs; do
      echo "== build $pkg"
      (cd "{{root}}/$pkg" && npm run build >/dev/null)
    done

# Run tests: [core|cache-dexie] [vitest args...]
test *args:
    #!/usr/bin/env bash
    set -euo pipefail
    pkg="${1:-core}"; [ "$#" -gt 0 ] && shift || true
    case "$pkg" in
      core|cache-dexie) cd "{{root}}/$pkg" && npx vitest run "$@" ;;
      *) echo "usage: just test {core|cache-dexie} [vitest args...]" >&2; exit 1 ;;
    esac

# Local and published versions of both packages
status:
    #!/usr/bin/env bash
    set -euo pipefail
    for pkg in core cache-dexie; do
      local_v="$(node -p "require('{{root}}/$pkg/package.json').version")"
      name="@bzzsocial/$([ "$pkg" = core ] && echo ndk || echo "$pkg")"
      npm_v="$(npm view "$name" dist-tags.latest 2>/dev/null || echo "not published")"
      printf '%-24s local %-16s npm latest %s\n' "$name" "$local_v" "$npm_v"
    done

# Bump the -bzz.N prerelease of a package: <core|cache-dexie>
bump pkg:
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1" in core|cache-dexie) ;; *) echo "usage: just bump {core|cache-dexie}" >&2; exit 1 ;; esac
    node - "{{root}}/$1/package.json" <<'EOF'
    const fs = require("fs");
    const file = process.argv[2];
    const src = fs.readFileSync(file, "utf8");
    const { version } = JSON.parse(src);
    const m = version.match(/^(.*-bzz\.)(\d+)$/);
    if (!m) throw new Error(`${version} has no -bzz.N suffix to bump`);
    const next = `${m[1]}${Number(m[2]) + 1}`;
    fs.writeFileSync(file, src.replace(`"version": "${version}"`, `"version": "${next}"`));
    console.log(`${version} -> ${next}; add a CHANGELOG entry, then commit "release: ..."`);
    EOF

# Publish to npm as @bzzsocial/*: [dry|run] [dist-tag]. Uses $NPM_TOKEN when set.
publish *args:
    #!/usr/bin/env bash
    set -euo pipefail
    case "${1:-dry}" in
      dry) dry="--dry-run" ;;
      run) dry="" ;;
      *) echo "usage: just publish {dry|run} [dist-tag]" >&2; exit 1 ;;
    esac
    tag="${2:-latest}"

    if [ -n "$(git -C "{{root}}" status --porcelain -- core cache-dexie)" ]; then
      echo "core/ or cache-dexie/ has uncommitted changes; commit them first" >&2
      exit 1
    fi

    stage="$(mktemp -d)"
    trap 'rm -rf "$stage"' EXIT
    if [ -n "${NPM_TOKEN:-}" ]; then
      printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$stage/npmrc"
      export NPM_CONFIG_USERCONFIG="$stage/npmrc"
    fi

    for pkg in core cache-dexie; do
      (cd "{{root}}/$pkg" && npm run build >/dev/null && npm pack --ignore-scripts --pack-destination "$stage" >/dev/null)
    done

    for tgz in "$stage"/*.tgz; do
      dir="${tgz%.tgz}"
      mkdir -p "$dir"
      tar -xzf "$tgz" -C "$dir" --strip-components=1
      # Built code and typings import @bzzsocial/ndk instead of the upstream name.
      grep -rlE "@nostr-dev-kit/(ndk|cache-dexie)\b" "$dir/dist" | xargs -r perl -pi -e 's#\@nostr-dev-kit/(ndk|cache-dexie)(?=[/"\x27`\s])#\@bzzsocial/$1#g'
      node - "$dir/package.json" <<'EOF'
    const fs = require("fs");
    const file = process.argv[2];
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    const sub = pkg.name.replace("@nostr-dev-kit/", "");
    const dir = sub === "ndk" ? "core" : sub;
    pkg.name = `@bzzsocial/${sub}`;
    pkg.homepage = `https://github.com/bzzsocial/ndk/tree/bzz/${dir}#readme`;
    pkg.bugs = { url: "https://github.com/bzzsocial/ndk/issues" };
    pkg.repository = { type: "git", url: "git+https://github.com/bzzsocial/ndk.git", directory: dir };
    delete pkg.documentation;
    // Build and lifecycle scripts belong to the workspace; the tarball is prebuilt.
    delete pkg.scripts;
    delete pkg.devDependencies;
    for (const field of ["dependencies", "peerDependencies"]) {
        const deps = pkg[field];
        if (deps?.["@nostr-dev-kit/ndk"]) {
            deps["@bzzsocial/ndk"] = ">=3.0.3-bzz.0";
            delete deps["@nostr-dev-kit/ndk"];
        }
    }
    pkg.publishConfig = { access: "public" };
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    EOF
      spec="$(node -p "const p=require('$dir/package.json'); p.name+'@'+p.version")"
      if npm view "$spec" version >/dev/null 2>&1; then
        echo "== $spec is already published, skipping"
        continue
      fi
      echo "== $spec (tag: $tag)"
      (cd "$dir" && npm publish $dry --tag "$tag" --access public)
    done

# Tag and create a GitHub release for each published version that lacks one
release:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    # Without this gh may pick the `upstream` remote.
    export GH_REPO="${GH_REPO:-bzzsocial/ndk}"
    for pkg in core cache-dexie; do
      version="$(node -p "require('./$pkg/package.json').version")"
      tag="@bzzsocial/$([ "$pkg" = core ] && echo ndk || echo "$pkg")@$version"
      if ! npm view "$tag" version >/dev/null 2>&1; then
        echo "== $tag is not on npm yet, skipping"; continue
      fi
      if gh release view "$tag" >/dev/null 2>&1; then
        echo "== $tag already released, skipping"; continue
      fi
      # Notes are this version's CHANGELOG section, without its heading.
      notes="$(awk -v v="## $version" '$0 == v {on=1; next} on && /^## / {exit} on' "$pkg/CHANGELOG.md")"
      [ -n "${notes//[[:space:]]/}" ] || { echo "no CHANGELOG section for $version in $pkg/CHANGELOG.md" >&2; exit 1; }
      echo "== release $tag"
      gh release create "$tag" --target "$(git rev-parse HEAD)" --title "$tag" --notes "$notes" --latest="$([ "$pkg" = core ] && echo true || echo false)"
    done

# Upstream nostr-dev-kit/ndk: [fetch|log|diff]
upstream *args:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    git rev-parse -q --verify upstream/master >/dev/null || git fetch -q upstream
    case "${1:-log}" in
      fetch) git fetch upstream ;;
      # Upstream commits not merged into this branch yet
      log) git log --oneline HEAD..upstream/master ;;
      # What the fork changes against upstream
      diff) git diff --stat "$(git merge-base HEAD upstream/master)" HEAD -- core cache-dexie ;;
      *) echo "usage: just upstream {fetch|log|diff}" >&2; exit 1 ;;
    esac
