#!/usr/bin/env bash
# The kit authenticates this helper before using it. Docker is the verifier runtime.
cosign_image='ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8'
cosign_config='sha256:192a38e9dabb6b28359fc4706992d91ad325f366630a68dd7c3d50bcef059db8'
proxy_release_image='caddy:2.11.7-alpine@sha256:d76116d819d5162f464b0f2cd09bd28c568a86148c7bc539ce17c33eb22d8bbb'
proxy_config='sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77'
cosign_index='sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8'
cosign_manifest='sha256:6ca1127dc1e9ff19f3f2bfa214936813a86fbbf52919652eda49d393c888ad3c'
proxy_index='sha256:d76116d819d5162f464b0f2cd09bd28c568a86148c7bc539ce17c33eb22d8bbb'
proxy_manifest='sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229'
release_identity="https://github.com/416rehman/Vectory/.github/workflows/release.yml@refs/tags/v$version"
cosign_verify() {
  mkdir -p "$bundle/.cache/sigstore"
  [[ ! -L "$bundle/.cache/sigstore" ]] || fail 'The retained Sigstore trust cache must be a directory.'
  docker run --pull=never --rm --network "${cosign_network:-bridge}" --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --env HOME=/cosign \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --mount "type=bind,src=$bundle/.cache,dst=/release,readonly" \
    --mount "type=bind,src=$bundle/.cache/sigstore,dst=/cosign" \
    "$cosign_image" "$@"
}
verified_download() {
  local name="$1" target="$bundle/.cache/$1"
  [[ "$name" =~ ^[A-Za-z0-9_.-]+$ && ! -L "$target" && ! -L "$target.part" ]] || fail 'Unsafe release cache file.'
  if [[ -n "${VECTORY_RELEASE_DIR:-}" ]]; then
    [[ -f "$VECTORY_RELEASE_DIR/$name" && ! -L "$VECTORY_RELEASE_DIR/$name" ]] || fail "No regular $name in the offline release folder."
    cp -- "$VECTORY_RELEASE_DIR/$name" "$target.part"
  else
    command -v curl >/dev/null || fail 'Install curl to fetch the release.'
    curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
      --connect-timeout 20 --max-time 1800 "$release/$name" -o "$target.part" || fail "Could not download $name. Retry after checking your network."
  fi
  mv -- "$target.part" "$target"
}
signed_file_checksum() {
  local selected="$1" digest name extra
  local -a found=()
  while read -r digest name extra; do
    if [[ "$name" == "$selected" ]]; then
      [[ "$digest" =~ ^[a-f0-9]{64}$ && -z "${extra:-}" ]] || fail 'Malformed signed release checksum.'
      found+=("$digest")
    fi
  done < "$bundle/.cache/SHA256SUMS"
  [[ ${#found[@]} == 1 ]] || fail "Signed inventory must identify $selected exactly once."
  [[ -f "$bundle/.cache/$selected" && ! -L "$bundle/.cache/$selected" ]] || fail "No regular verified $selected."
  printf '%s  %s\n' "${found[0]}" "$bundle/.cache/$selected" | sha256sum --check --strict >/dev/null || fail "Signed checksum failed for $selected."
}
load_pinned_offline_dependency() {
  local archive="$1" expected_config="$2" expected_index="$3" expected_manifest="$4" identity='' candidate
  for candidate in "$expected_config" "$expected_index" "$expected_manifest"; do
    if docker image inspect "$candidate" >/dev/null 2>&1; then identity="$candidate"; break; fi
  done
  if [[ -z "$identity" ]]; then
    [[ -f "$bundle/.cache/$archive" && ! -L "$bundle/.cache/$archive" ]] || fail "Offline installation needs its prepared $archive."
    docker load --input "$bundle/.cache/$archive" >/dev/null || fail "Could not load $archive."
    for candidate in "$expected_config" "$expected_index" "$expected_manifest"; do
      if docker image inspect "$candidate" >/dev/null 2>&1; then identity="$candidate"; break; fi
    done
  fi
  [[ -n "$identity" ]] || fail "Offline $archive differs from every authenticated index, platform manifest and configuration identity."
  checked_dependency_id "$identity" "$expected_config" "$expected_index" "$expected_manifest"
}
checked_dependency_id() {
  local image="$1" expected_config="$2" expected_index="$3" expected_manifest="$4" actual platform
  actual="$(docker image inspect "$image" --format '{{.Id}}')"
  [[ "$actual" == "$expected_config" || "$actual" == "$expected_index" || "$actual" == "$expected_manifest" ]] || fail 'Pinned dependency identity differs from its authenticated index, platform manifest and configuration.'
  platform="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
  [[ "$platform" == linux/amd64 ]] || fail 'Pinned dependency must be Linux amd64.'
  dependency_image="$actual"
}
check_archive_config() {
  local archive="$1" identity="$2" selected
  local -a names=()
  mapfile -t names < <(tar -tzf "$bundle/.cache/$archive" | grep -E "^(${identity#sha256:}\.json|blobs/sha256/${identity#sha256:})$" || true)
  [[ ${#names[@]} == 1 ]] || fail 'Signed image archive does not identify its expected configuration exactly once.'
  selected="$(tar -xOzf "$bundle/.cache/$archive" "${names[0]}" | sha256sum | cut -d ' ' -f 1)"
  [[ "sha256:$selected" == "$identity" ]] || fail 'Signed archive configuration digest differs from the signed image identity.'
}
load_signed_images() {
  mkdir -p "$bundle/.cache"
  [[ ! -L "$bundle/.cache" ]] || fail 'The release cache must be a regular directory.'
  release="https://github.com/416rehman/Vectory/releases/download/v$version"
  # A missing proof never falls back to an unsigned checksum.
  for name in SHA256SUMS SHA256SUMS.sigstore.json IMAGE-DIGESTS.env IMAGE-CONFIGS.env; do
    [[ ! -L "$bundle/.cache/$name" ]] || fail 'The release cache must not contain links.'
    [[ -f "$bundle/.cache/$name" ]] || verified_download "$name"
  done
  say "Verifying Vectory $version from its GitHub release identity..."
  verification_options=()
  if [[ "${VECTORY_OFFLINE:-false}" == true ]]; then
    root="$bundle/.cache/sigstore/.sigstore/root/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json"
    [[ -f "$root" && ! -L "$root" ]] || fail 'Offline installation requires the Sigstore trust root from a verified connected preparation.'
    load_pinned_offline_dependency cosign-image.tar.gz "$cosign_config" "$cosign_index" "$cosign_manifest"
    cosign_image="$dependency_image"
    cosign_network=none
    verification_options=(--offline --trusted-root /cosign/.sigstore/root/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json)
  else
    docker image inspect "$cosign_image" >/dev/null 2>&1 || docker pull "$cosign_image" >/dev/null || fail 'Could not fetch the pinned release verifier.'
    checked_dependency_id "$cosign_image" "$cosign_config" "$cosign_index" "$cosign_manifest"
  fi
  cosign_verify verify-blob --bundle /release/SHA256SUMS.sigstore.json \
    "${verification_options[@]}" \
    --certificate-identity "$release_identity" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    /release/SHA256SUMS >/dev/null || fail 'Release signature verification failed. No Vectory image was started.'
  signed_file_checksum IMAGE-DIGESTS.env
  signed_file_checksum IMAGE-CONFIGS.env
  declare -A references=()
  while IFS='=' read -r name image; do
    case "$name" in VECTORY_SERVER_IMAGE) component=server ;; VECTORY_VALIDATOR_IMAGE) component=validator ;; *) fail 'Unexpected image manifest setting.' ;; esac
    [[ -z "${references[$name]:-}" && "$image" =~ ^ghcr\.io/416rehman/vectory-$component@sha256:[a-f0-9]{64}$ ]] || fail 'The signed manifest must name unique immutable Vectory image digests.'
    references[$name]="$image"
  done < "$bundle/.cache/IMAGE-DIGESTS.env"
  [[ ${#references[@]} == 2 ]] || fail 'The signed image manifest is incomplete.'
  server_image="${references[VECTORY_SERVER_IMAGE]}"
  validator_image="${references[VECTORY_VALIDATOR_IMAGE]}"
  declare -A configs=()
  while IFS='=' read -r name identity; do
    case "$name" in VECTORY_SERVER_IMAGE|VECTORY_VALIDATOR_IMAGE) ;; *) fail 'Unexpected image configuration setting.' ;; esac
    [[ -z "${configs[$name]:-}" && "$identity" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Signed local image identities are malformed or repeated.'
    configs[$name]="$identity"
  done < "$bundle/.cache/IMAGE-CONFIGS.env"
  [[ ${#configs[@]} == 2 ]] || fail 'Signed local image identities are incomplete.'
  if [[ "${VECTORY_OFFLINE:-false}" == true ]]; then
    for component in server validator; do
      local setting="VECTORY_${component^^}_IMAGE" archive="vectory-$component-image.tar.gz"
      identity="${configs[$setting]}"
      if [[ -f "$bundle/.cache/$archive" && ! -L "$bundle/.cache/$archive" ]]; then
        signed_file_checksum "$archive"
        check_archive_config "$archive" "$identity"
        docker load --input "$bundle/.cache/$archive" >/dev/null || fail "Could not load signed $component image archive."
        image="vectory-$component:candidate"
      elif docker image inspect "${references[$setting]}" >/dev/null 2>&1; then
        image="${references[$setting]}"
      else
        fail 'Offline installation needs its signed image archives or previously authenticated registry images.'
      fi
      execution_id="$(docker image inspect "$image" --format '{{.Id}}')"
      [[ "$execution_id" =~ ^sha256:[a-f0-9]{64}$ && "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" == linux/amd64 ]] || fail 'Loaded signed image has no immutable Linux amd64 identity.'
      if [[ "$component" == server ]]; then server_image="$execution_id"; else validator_image="$execution_id"; fi
    done
    proxy_image="$proxy_config"
    if [[ -f "$bundle/Caddyfile" ]]; then
      load_pinned_offline_dependency proxy-image.tar.gz "$proxy_config" "$proxy_index" "$proxy_manifest"
      proxy_image="$dependency_image"
    fi
    return
  fi
  for image in "$server_image" "$validator_image"; do
    cosign_verify verify --certificate-identity "$release_identity" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$image" >/dev/null || fail 'Container signature verification failed.'
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      say "Pulling $image..."
      docker pull "$image" >/dev/null || fail 'Could not pull the verified public image. Retry after checking your network.'
    fi
  done
  proxy_image="$proxy_release_image"
  if [[ -f "$bundle/Caddyfile" ]]; then
    docker image inspect "$proxy_image" >/dev/null 2>&1 || docker pull "$proxy_image" >/dev/null || fail 'Could not pull the pinned HTTPS proxy.'
    checked_dependency_id "$proxy_image" "$proxy_config" "$proxy_index" "$proxy_manifest"
  fi
}
