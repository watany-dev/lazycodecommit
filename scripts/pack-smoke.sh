#!/usr/bin/env bash
# Install the packed tarball the way a user would (npm, not Bun) and run its bin.
# Usage: pack-smoke.sh [package.tgz]   (packs the working tree when omitted)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
want=$(node -p 'require(process.argv[1]).version' "$root/package.json")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ $# -ge 1 ]; then
  tgz=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
else
  tgz="$work/$(cd "$root" && npm pack --silent --pack-destination "$work")"
fi

npm install --silent --no-audit --no-fund --prefix "$work/prefix" "$tgz"
for bin in lazycodecommit lazycc; do
  got=$("$work/prefix/node_modules/.bin/$bin" --version)
  if [ "$got" != "$want" ]; then
    echo "pack-smoke: $bin --version printed '$got', want '$want'" >&2
    exit 1
  fi
done
echo "pack-smoke: ok ($(node --version), $want)"
