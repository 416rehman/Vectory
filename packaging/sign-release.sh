#!/bin/sh
# Run manually in a controlled signing environment with an existing cosign key.
set -eu
if [ "$#" -ne 2 ]; then
  echo 'usage: sign-release.sh RELEASE_DIRECTORY COSIGN_KEY_REFERENCE' >&2
  exit 2
fi
release_dir=$1
key_ref=$2
test -f "$release_dir/SHA256SUMS"
(cd "$release_dir" && sha256sum -c SHA256SUMS)
cosign sign-blob --yes --key "$key_ref" --tlog-upload=false \
  --output-signature "$release_dir/SHA256SUMS.sig" "$release_dir/SHA256SUMS"
echo 'Detached signature created. Distribute the established public key independently.'
