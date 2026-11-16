#!/usr/bin/env bash
# Install the packed tarball the way a user would (npm, not Bun) and run its bin:
# --version from both names, then the paths --version never loads (smoke-dist.mjs).
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
if [ ! -s "$work/prefix/node_modules/lazycodecommit/dist/THIRD_PARTY_LICENSES.txt" ]; then
  echo "pack-smoke: the package ships no dist/THIRD_PARTY_LICENSES.txt" >&2
  exit 1
fi
# --version loads neither the AWS SDK nor the TUI; this runs them from the package.
node "$root/scripts/smoke-dist.mjs" "$work/prefix/node_modules/.bin/lazycc"
echo "pack-smoke: ok ($(node --version), $want)"
