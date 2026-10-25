#!/usr/bin/env bash
# Publish the bzz fork of ndk and cache-dexie to npm as @bzzsocial/ndk and
# @bzzsocial/cache-dexie. The workspace keeps the upstream @nostr-dev-kit names;
# only the packed copies are renamed, and their built code and peer
# dependencies point at @bzzsocial/ndk, so consumers import @bzzsocial/* directly.
# Versions already on the registry are skipped.
#
# Usage: scripts/publish-bzz.sh [--publish] [--tag <dist-tag>]
# Without --publish it runs `npm publish --dry-run`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dry="--dry-run"
tag="latest"
while [ $# -gt 0 ]; do
    case "$1" in
        --publish) dry="" ;;
        --tag) tag="${2:?--tag needs a value}"; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

if [ -n "$(git -C "$root" status --porcelain -- core cache-dexie)" ]; then
    echo "core/ or cache-dexie/ has uncommitted changes; commit them first" >&2
    exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

for pkg in core cache-dexie; do
    if command -v bun >/dev/null; then
        (cd "$root/$pkg" && bun run build >/dev/null && bun pm pack --destination "$stage" --quiet >/dev/null)
    else
        (cd "$root/$pkg" && npm run build >/dev/null && npm pack --ignore-scripts --pack-destination "$stage" >/dev/null)
    fi
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
pkg.name = `@bzzsocial/${sub}`;
pkg.homepage = `https://github.com/bzzsocial/ndk/tree/bzz/${sub === "ndk" ? "core" : sub}#readme`;
pkg.bugs = { url: "https://github.com/bzzsocial/ndk/issues" };
pkg.repository = {
    type: "git",
    url: "git+https://github.com/bzzsocial/ndk.git",
    directory: sub === "ndk" ? "core" : sub,
};
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
