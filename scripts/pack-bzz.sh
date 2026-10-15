#!/usr/bin/env bash
# Build @nostr-dev-kit/ndk and @nostr-dev-kit/cache-dexie and pack them as
# tarballs for bzzapp to vendor. Usage: scripts/pack-bzz.sh <dest-dir>
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$(mkdir -p "${1:?usage: $0 <dest-dir>}" && cd "$1" && pwd)"

for pkg in core cache-dexie; do
    (cd "$root/$pkg" && bun run build >/dev/null && bun pm pack --destination "$dest" --quiet)
done

ls -1 "$dest"/*.tgz
