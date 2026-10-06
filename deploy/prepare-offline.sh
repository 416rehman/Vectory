#!/usr/bin/env bash
# Prepare a signed source-free kit on a connected host without starting Vectory.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
bundle="$(pwd -P)"
fail() { printf 'Vectory: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
[[ $# == 1 && "$1" == /* ]] || fail 'Usage: ./prepare-offline.sh /absolute/path/to/new-offline-kit'
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || fail 'Preparation requires a Linux x86-64 Docker host.'
[[ "${VECTORY_OFFLINE:-false}" != true && "${VECTORY_UNSIGNED_CANDIDATE:-false}" != true ]] || fail 'Preparation requires actual signed online release verification.'
for tool in docker curl sha256sum; do command -v "$tool" >/dev/null || fail "Install $tool first."; done
[[ -f SHA256SUMS && ! -L SHA256SUMS ]] || fail 'The original kit checksum inventory must be regular.'
declare -A seen=()
while read -r checksum name extra; do
  [[ "$checksum" =~ ^[a-f0-9]{64}$ && -z "${extra:-}" && -z "${seen[$name]:-}" ]] || fail 'Malformed kit inventory.'
  case "$name" in start.sh|start-auto.sh|prepare-offline.sh|release-images.sh|verify-release.sh|compose.yaml|compose.auto.yaml|Caddyfile|Caddyfile.auto|.env.example|README.md|LICENSE|NOTICE|VERSION) ;; *) fail 'Unexpected kit member.' ;; esac
  [[ -f "$name" && ! -L "$name" ]] || fail 'The original kit must contain regular files only.'
  seen[$name]=1
done < SHA256SUMS
[[ ${#seen[@]} == 9 || ${#seen[@]} == 14 ]] || fail 'The original kit inventory is incomplete.'
sha256sum --check --strict SHA256SUMS >/dev/null || fail 'Original kit checksum failed.'
version="$(cat VERSION)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Offline preparation requires a stable release.'
target="$1"
[[ ! -e "$target" && ! -L "$target" ]] || fail 'Use a new destination directory; preparation does not replace existing state.'
source "$bundle/verify-release.sh"
load_signed_images
for name in vectory-server-image.tar.gz vectory-validator-image.tar.gz; do
  [[ -f "$bundle/.cache/$name" && ! -L "$bundle/.cache/$name" ]] || verified_download "$name"
  signed_file_checksum "$name"
done
root="$bundle/.cache/sigstore/.sigstore/root/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json"
[[ -f "$root" && ! -L "$root" ]] || fail 'The verified Sigstore trust root was not retained by the verifier.'
for dependency in cosign proxy; do
  if [[ "$dependency" == cosign ]]; then image="$cosign_image"; identity="$cosign_config"; index="$cosign_index"; manifest="$cosign_manifest"; else image="$proxy_release_image"; identity="$proxy_config"; index="$proxy_index"; manifest="$proxy_manifest"; fi
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null || fail "Could not pull the pinned $dependency image."
  checked_dependency_id "$image" "$identity" "$index" "$manifest"
  docker save "$dependency_image" | gzip -n > "$bundle/.cache/$dependency-image.tar.gz.part"
  mv -- "$bundle/.cache/$dependency-image.tar.gz.part" "$bundle/.cache/$dependency-image.tar.gz"
done
mkdir -m 0700 -- "$target"
for name in "${!seen[@]}" SHA256SUMS; do cp -- "$bundle/$name" "$target/$name"; done
chmod 0755 -- "$target/start.sh" "$target/prepare-offline.sh"
mkdir -m 0700 -- "$target/.cache"
for name in SHA256SUMS SHA256SUMS.sigstore.json IMAGE-DIGESTS.env IMAGE-CONFIGS.env vectory-server-image.tar.gz vectory-validator-image.tar.gz cosign-image.tar.gz proxy-image.tar.gz; do
  [[ -f "$bundle/.cache/$name" && ! -L "$bundle/.cache/$name" ]] || fail "Cannot transfer irregular $name."
  cp -- "$bundle/.cache/$name" "$target/.cache/$name"
done
root_directory="$target/.cache/sigstore/.sigstore/root/tuf-repo-cdn.sigstore.dev/targets"
mkdir -p -- "$root_directory"
cp -- "$root" "$root_directory/trusted_root.json"
say "Prepared $target without starting a manager or activating a device."
say 'Transfer this entire directory through a trusted channel, including its independently verified Sigstore root and pinned verifier image.'
say 'On the offline Linux x86-64 host, supply your HTTPS certificate files and run VECTORY_OFFLINE=true VECTORY_CERTIFICATE_MODE=custom ./start.sh.'
