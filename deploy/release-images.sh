#!/usr/bin/env bash
# Shared prebuilt-image loader. Source only after checking the bundle SHA256SUMS.
load_release_images() {
mkdir -p .cache
[[ ! -L .cache ]] || fail "The preview cache must be a regular directory."
for inventory in .cache/release-SHA256SUMS .cache/release-SHA256SUMS.part; do [[ ! -L "$inventory" ]] || fail "The cached release inventory must not be a link."; done
release="https://github.com/416rehman/Vectory/releases/download/v$version"
images=(vectory-server-image.tar.gz vectory-validator-image.tar.gz)
if [[ -n "${VECTORY_PREVIEW_RELEASE_DIR:-}" ]]; then
  source_dir="$(cd -- "$VECTORY_PREVIEW_RELEASE_DIR" && pwd -P)"
  [[ -f "$source_dir/SHA256SUMS" && ! -L "$source_dir/SHA256SUMS" ]] || fail "VECTORY_PREVIEW_RELEASE_DIR has no regular SHA256SUMS file."
  cp -- "$source_dir/SHA256SUMS" .cache/release-SHA256SUMS.part
  mv -- .cache/release-SHA256SUMS.part .cache/release-SHA256SUMS
elif [[ ! -f .cache/release-SHA256SUMS ]]; then
  command -v curl >/dev/null || fail "Install curl, then run ./start.sh again."
  say "Getting the Vectory $version release checksums..."
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 120 "$release/SHA256SUMS" -o .cache/release-SHA256SUMS.part || fail "Release $version is not available, or the download failed. Run ./start.sh again after checking your connection."
  mv -- .cache/release-SHA256SUMS.part .cache/release-SHA256SUMS
else
  say "Using the retained Vectory $version release checksums..."
fi
declare -a digests=()
for image in "${images[@]}"; do
  # Do not pass the whole remote manifest to sha256sum: it also lists files
  # this starter does not download, and no remote path should select a file.
  matches=()
  while read -r checksum name extra; do
    if [[ "$name" == "$image" ]]; then
      [[ "$checksum" =~ ^[0-9a-f]{64}$ && -z "${extra:-}" ]] || fail "Malformed release checksum for $image."
      matches+=("$checksum")
    fi
  done < .cache/release-SHA256SUMS
  [[ ${#matches[@]} == 1 ]] || fail "Release checksums must list $image exactly once."
  expected="${matches[0]}"
  digests+=("$expected")
  cached="$bundle/.cache/$image"
  [[ ! -L "$cached" && ! -L "$cached.part" ]] || fail "The cached image must not be a link."
  if [[ ! -f "$cached" ]] || [[ "$(sha256sum "$cached" | cut -d ' ' -f 1)" != "$expected" ]]; then
    if [[ -n "${VECTORY_PREVIEW_RELEASE_DIR:-}" ]]; then
      [[ -f "$source_dir/$image" && ! -L "$source_dir/$image" ]] || fail "No regular $image in VECTORY_PREVIEW_RELEASE_DIR."
      cp -- "$source_dir/$image" "$cached.part"
    else
      command -v curl >/dev/null || fail "Install curl to download a missing image, then run ./start.sh again."
      say "Downloading $image (first start only)..."
      curl --fail --location --show-error --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 1800 "$release/$image" -o "$cached.part" || fail "Image download failed. Run ./start.sh again to retry."
    fi
    printf '%s  %s\n' "$expected" "$cached.part" | sha256sum --check --strict >/dev/null || fail "Image checksum failed for $image. Nothing was loaded. Run ./start.sh again to retry."
    mv -- "$cached.part" "$cached"
  fi
done

server_image="vectory-preview-server:$version-${digests[0]:0:16}"
validator_image="vectory-preview-validator:$version-${digests[1]:0:16}"
for index in 0 1; do
  if [[ "$index" == 0 ]]; then target="$server_image"; candidate=vectory-server:candidate; else target="$validator_image"; candidate=vectory-validator:candidate; fi
  if ! docker image inspect "$target" >/dev/null 2>&1; then
    say "Loading verified ${images[$index]}..."
    docker load --input "$bundle/.cache/${images[$index]}" >/dev/null
    docker tag "$candidate" "$target"
  fi
done
}
