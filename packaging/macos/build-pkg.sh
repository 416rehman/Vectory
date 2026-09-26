#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo 'usage: build-pkg.sh AGENT_BINARY VERSION OUTPUT.pkg' >&2
  exit 2
fi
binary=$1
version=$2
output=$3
test ! -e "$output"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/usr/local/bin"
install -m 0755 "$binary" "$stage/usr/local/bin/vectory"
pkgbuild --root "$stage" --identifier com.vectory.agent --version "$version" --install-location / "$output"
echo 'Unsigned package built. Native signing, notarization and installation acceptance are separate gates.'
