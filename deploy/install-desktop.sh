#!/usr/bin/env bash
# HTTPS bootstrap for the unchanged, signed Vectory server kit.
# Portable to macOS's system Bash; Docker must run Linux x86-64 containers.
set -euo pipefail
version='0.2.1'
fail() { printf 'Vectory: %s\n' "$*" >&2; exit 1; }
action="${1:-start}"
[[ $# -le 1 ]] || fail 'Usage: bash vectory-install.sh [start|stop|status|setup-secret]'
case "$action" in start|stop|status|setup-secret) ;; *) fail 'Use start, stop, status or setup-secret.' ;; esac
case "$(uname -s)/$(uname -m)" in Darwin/x86_64|Darwin/arm64|Linux/x86_64|Linux/aarch64) ;; *) fail 'Use Linux or macOS with a supported Linux Docker engine.' ;; esac
for tool in docker curl tar cmp; do command -v "$tool" >/dev/null || fail "Install $tool, then retry."; done
if command -v sha256sum >/dev/null; then sha() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null; then sha() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else fail 'The system SHA-256 utility is missing.'; fi
docker compose version >/dev/null 2>&1 || fail 'Install Docker Desktop with Compose v2, then retry.'
docker info >/dev/null 2>&1 || fail 'Start Docker Desktop and wait until its engine is running.'
platform="$(docker info --format '{{.OSType}}/{{.Architecture}}')"
[[ "$platform" =~ ^linux/(amd64|x86_64|aarch64|arm64)$ ]] || fail 'Select a supported Linux Docker engine. Windows containers are not supported.'
if [[ "$platform" =~ /(aarch64|arm64)$ && "${VECTORY_ALLOW_AMD64_EMULATION:-false}" != true ]]; then
  read -r -p 'This release uses Linux x86-64 images. Run them with Docker Desktop amd64 emulation? [y/N] ' consent
  case "$consent" in y|Y|yes|YES) ;; *) fail 'No services were started. Use a Linux x86-64 server, or retry after enabling amd64 emulation.' ;; esac
fi
target="${VECTORY_INSTALL_DIRECTORY:-$PWD/vectory}"
[[ "$target" == /* && "$target" != *','* && "$target" != *$'\n'* && ! -L "$target" ]] || fail 'Use an absolute ordinary installation directory without commas or line breaks.'
if [[ -e "$target" ]]; then [[ -d "$target" ]] || fail 'The installation target must be a directory.'; fi
mkdir -p "$target"
bundle="$(cd "$target" && pwd -P)"
cache="$bundle/.cache"
lock="$bundle/.desktop-lock"
progress="$bundle/.desktop-installing"
mkdir "$lock" 2>/dev/null || fail 'Another installer is running, or a retained .desktop-lock needs inspection.'
trap 'rmdir "$lock"' EXIT
cosign_image='ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8'
proxy_image='caddy:2.11.7-alpine@sha256:d76116d819d5162f464b0f2cd09bd28c568a86148c7bc539ce17c33eb22d8bbb'
release="https://github.com/416rehman/Vectory/releases/download/v$version"
identity="https://github.com/416rehman/Vectory/.github/workflows/release.yml@refs/tags/v$version"
kit="vectory-$version-server-linux-amd64"
expected=(.env.example Caddyfile Caddyfile.auto LICENSE NOTICE README.md SHA256SUMS VERSION compose.auto.yaml compose.yaml prepare-offline.sh release-images.sh start-auto.sh start.sh verify-release.sh)
regular() { [[ -f "$1" && ! -L "$1" ]]; }
cosign_verify() {
  docker run --platform linux/amd64 --rm --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --env HOME=/tmp --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --mount "type=bind,src=$cache,dst=/release,readonly" "$cosign_image" "$@"
}
signed_checksum() {
  local name="$1" path="$2" digest='' count=0 selected file extra
  regular "$cache/SHA256SUMS" && regular "$path" || fail 'A verified release file must be regular.'
  while read -r selected file extra; do
    if [[ "$file" == "$name" ]]; then
      [[ "$selected" =~ ^[a-f0-9]{64}$ && -z "${extra:-}" ]] || fail 'Malformed signed checksum.'
      digest="$selected"; count=$((count+1))
    fi
  done < "$cache/SHA256SUMS"
  [[ "$count" == 1 && "$(sha "$path")" == "$digest" ]] || fail "Signed checksum failed for $name."
}
authenticate() {
  regular "$cache/SHA256SUMS.sigstore.json" || fail 'The signed release proof is missing.'
  cosign_verify verify-blob --bundle /release/SHA256SUMS.sigstore.json --certificate-identity "$identity" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com /release/SHA256SUMS >/dev/null || fail 'Release signature verification failed.'
}
if [[ ! -e "$bundle/VERSION" ]]; then
  resume=false
  if regular "$progress" && [[ "$(cat "$progress")" == "$version" ]]; then resume=true; fi
  if [[ "$resume" != true ]]; then
    [[ "$(ls -A "$bundle")" == .desktop-lock ]] || fail 'Choose an empty directory, or resume your original kit directory.'
    (umask 077; printf '%s\n' "$version" > "$progress")
  else
    for path in "$bundle"/.[!.]* "$bundle"/..?* "$bundle"/*; do
      [[ -e "$path" || -L "$path" ]] || continue
      name="${path##*/}"; allowed=false
      case "$name" in .desktop-lock) [[ -d "$path" && ! -L "$path" ]] || fail 'The operation lock was replaced.'; continue ;; .cache) [[ -d "$path" && ! -L "$path" ]] || fail 'The download cache must be an ordinary directory.'; continue ;; .desktop-installing|VERSION.part) allowed=true ;; esac
      for expected_name in "${expected[@]}"; do [[ "$name" != "$expected_name" ]] || allowed=true; done
      [[ "$allowed" == true && -f "$path" && ! -L "$path" ]] || fail 'Unexpected or linked interrupted-install content; no unknown files were deleted.'
    done
  fi
  [[ ! -L "$cache" && ( ! -e "$cache" || -d "$cache" ) ]] || fail 'The download cache must be an ordinary directory.'
  if [[ ! -e "$cache" ]]; then mkdir -m 0700 "$cache"; fi
  for path in "$cache"/.[!.]* "$cache"/..?* "$cache"/*; do
    [[ -e "$path" || -L "$path" ]] || continue
    name="${path##*/}"
    case "$name" in SHA256SUMS|SHA256SUMS.part|SHA256SUMS.sigstore.json|SHA256SUMS.sigstore.json.part|IMAGE-DIGESTS.env|IMAGE-DIGESTS.env.part|IMAGE-CONFIGS.env|IMAGE-CONFIGS.env.part|"$kit.tar.gz"|"$kit.tar.gz.part"|expected|members) ;; *) fail 'Unknown interrupted download; no unknown files were deleted.' ;; esac
    regular "$path" && [[ "$(wc -c < "$path")" -le 2097152 ]] || fail 'Interrupted downloads must be bounded regular files, not links.'
  done
  printf 'Downloading the official Vectory %s server kit...\n' "$version"
  for name in SHA256SUMS SHA256SUMS.sigstore.json IMAGE-DIGESTS.env IMAGE-CONFIGS.env "$kit.tar.gz"; do
    curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --connect-timeout 20 --max-time 300 --max-filesize 2097152 "$release/$name" -o "$cache/$name" || fail "Could not download $name. Nothing was started."
  done
  printf 'Verifying the downloaded release before extraction...\n'
  authenticate
  signed_checksum "$kit.tar.gz" "$cache/$kit.tar.gz"
  printf '%s\n' "${expected[@]/#/$kit/}" | LC_ALL=C sort > "$cache/expected"
  tar -tzf "$cache/$kit.tar.gz" | LC_ALL=C sort > "$cache/members"
  cmp -s "$cache/expected" "$cache/members" || fail 'The verified kit has an unexpected file inventory.'
  [[ -z "$(tar -tvzf "$cache/$kit.tar.gz" | awk 'substr($0,1,1)!="-"')" ]] || fail 'The kit must contain regular files only.'
  tar -xzf "$cache/$kit.tar.gz" --no-same-owner --no-same-permissions --strip-components=1 --exclude "$kit/VERSION" -C "$bundle"
  [[ "$(tar -xOzf "$cache/$kit.tar.gz" "$kit/VERSION")" == "$version" ]] || fail 'The signed archive version does not match this installer.'
  [[ ! -L "$bundle/VERSION.part" ]] || fail 'The temporary version marker must not be a link.'
  printf '%s\n' "$version" > "$bundle/VERSION.part"
  mv "$bundle/VERSION.part" "$bundle/VERSION"
fi
[[ -d "$cache" && ! -L "$cache" ]] || fail 'The release cache must be an ordinary directory.'
regular "$bundle/SHA256SUMS" && regular "$bundle/VERSION" || fail 'The kit version and checksums must be regular files.'
[[ "$(cat "$bundle/VERSION")" == "$version" ]] || fail "This bootstrap manages only the verified $version kit."
for name in "${expected[@]}"; do regular "$bundle/$name" || fail "Missing or linked kit file: $name"; done
while read -r digest name extra; do
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -z "${extra:-}" ]] || fail 'Malformed kit checksum inventory.'
  found=false; for expected_name in "${expected[@]}"; do [[ "$name" != "$expected_name" || "$name" == SHA256SUMS ]] || found=true; done
  [[ "$found" == true && "$(sha "$bundle/$name")" == "$digest" ]] || fail 'The retained kit differs from its checked inventory.'
done < "$bundle/SHA256SUMS"
if [[ -e "$progress" || -L "$progress" ]]; then regular "$progress" && [[ "$(cat "$progress")" == "$version" ]] || fail 'The interrupted-install marker is unexpected or linked.'; rm "$progress"; fi
project="${VECTORY_SERVER_PROJECT:-vectory}"
envfile="$bundle/.env"
journal="$bundle/.setup.desktop.env"
mode="${VECTORY_CERTIFICATE_MODE:-automatic}"
if regular "$envfile"; then
  stored_mode="$(sed -n 's/^VECTORY_CERTIFICATE_MODE=//p' "$envfile")"
  [[ -z "${VECTORY_CERTIFICATE_MODE:-}" || "$mode" == "$stored_mode" ]] || fail 'Resume using the original certificate mode.'
  mode="$stored_mode"
elif [[ -n "${VECTORY_TLS_CERT_FILE:-}${VECTORY_TLS_KEY_FILE:-}" || -e "$journal" ]]; then
  [[ -z "${VECTORY_CERTIFICATE_MODE:-}" || "$mode" == custom ]] || fail 'Supplied certificate files require custom mode.'
  mode=custom
fi
case "$mode" in automatic|custom) ;; *) fail 'Certificate mode must be automatic or custom.' ;; esac
if regular "$envfile"; then
  stored_project="$(sed -n 's/^VECTORY_SERVER_PROJECT=//p' "$envfile")"
  if [[ -n "$stored_project" ]]; then
    [[ -z "${VECTORY_SERVER_PROJECT:-}" || "$project" == "$stored_project" ]] || fail 'Resume with the original project name.'
    project="$stored_project"
  fi
fi
[[ "$project" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || fail 'Project must use 1 to 40 lowercase letters, digits or hyphens.'
platform_file="$bundle/.desktop-platform.yaml"
platform_text=$'services:\n  server:\n    platform: linux/amd64\n  validator:\n    platform: linux/amd64\n  proxy:\n    platform: linux/amd64'
compose_file="$bundle/compose.yaml"
if [[ "$mode" == automatic ]]; then compose_file="$bundle/compose.auto.yaml"; platform_text+=$'\n  certificates:\n    platform: linux/amd64'; fi
if [[ -e "$platform_file" || -L "$platform_file" ]]; then
  regular "$platform_file" && [[ "$(cat "$platform_file")" == "$platform_text" ]] || fail 'The platform override was changed or is a link.'
else printf '%s\n' "$platform_text" > "$platform_file"; fi
compose() (
  for setting in $(env | sed -n 's/^\(VECTORY_[A-Z0-9_]*\)=.*/\1/p'); do unset "$setting"; done
  docker compose --project-name "$project" --env-file "$envfile" -f "$compose_file" -f "$platform_file" "$@"
)
if [[ "$action" != start ]]; then
  regular "$envfile" || fail 'Start this kit once before using this action.'
  case "$action" in stop) compose stop; printf 'Server stopped. Database and certificates are retained.\n' ;; status) compose ps ;; setup-secret) compose exec -T server cat /run/secrets/bootstrap ;; esac
  exit 0
fi
for name in SHA256SUMS SHA256SUMS.sigstore.json IMAGE-DIGESTS.env IMAGE-CONFIGS.env "$kit.tar.gz"; do
  if [[ -e "$cache/$name" || -L "$cache/$name" ]]; then regular "$cache/$name" || fail 'Release cache entries must be regular files.'
  else curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 300 --max-filesize 2097152 "$release/$name" -o "$cache/$name" || fail "Could not download $name."; fi
done
printf 'Verifying the retained release and prebuilt container images...\n'
authenticate
signed_checksum "$kit.tar.gz" "$cache/$kit.tar.gz"
[[ ! -L "$cache/kit-inventory" ]] || fail 'The checked kit inventory must not be a link.'
tar -xOzf "$cache/$kit.tar.gz" "$kit/SHA256SUMS" > "$cache/kit-inventory"
cmp -s "$cache/kit-inventory" "$bundle/SHA256SUMS" || fail 'The kit inventory differs from the signed archive.'
for name in IMAGE-DIGESTS.env IMAGE-CONFIGS.env; do signed_checksum "$name" "$cache/$name"; done
server_image=''; validator_image=''; server_config=''; validator_config=''
for manifest in IMAGE-DIGESTS.env IMAGE-CONFIGS.env; do
  while IFS='=' read -r name value; do
    case "$name" in VECTORY_SERVER_IMAGE) component=server ;; VECTORY_VALIDATOR_IMAGE) component=validator ;; *) fail 'Unexpected signed image setting.' ;; esac
    if [[ "$manifest" == IMAGE-DIGESTS.env ]]; then
      [[ "$value" =~ ^ghcr\.io/416rehman/vectory-$component@sha256:[a-f0-9]{64}$ ]] || fail 'Signed image reference must be an immutable Vectory digest.'
      if [[ "$component" == server ]]; then [[ -z "$server_image" ]] || fail 'Duplicate server image.'; server_image="$value"; else [[ -z "$validator_image" ]] || fail 'Duplicate validator image.'; validator_image="$value"; fi
    else
      [[ "$value" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Malformed signed image configuration.'
      if [[ "$component" == server ]]; then [[ -z "$server_config" ]] || fail 'Duplicate server configuration.'; server_config="$value"; else [[ -z "$validator_config" ]] || fail 'Duplicate validator configuration.'; validator_config="$value"; fi
    fi
  done < "$cache/$manifest"
done
[[ -n "$server_image" && -n "$validator_image" && -n "$server_config" && -n "$validator_config" ]] || fail 'Signed image manifests are incomplete.'
printf 'Getting the verified server, validator and HTTPS proxy images...\n'
for image in "$server_image" "$validator_image"; do
  cosign_verify verify --certificate-identity "$identity" --certificate-oidc-issuer https://token.actions.githubusercontent.com "$image" >/dev/null || fail 'Image signature verification failed.'
  docker pull --platform linux/amd64 "$image" >/dev/null
  if [[ "$image" == "$server_image" ]]; then config="$server_config"; else config="$validator_config"; fi
  execution_id="$(docker image inspect "$image" --format '{{.Id}}')"
  [[ ( "$execution_id" == "$config" || "$execution_id" == "${image##*@}" ) && "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" == linux/amd64 ]] || fail 'Pulled image differs from its signed immutable identity or platform.'
done
docker pull --platform linux/amd64 "$proxy_image" >/dev/null
proxy_id="$(docker image inspect "$proxy_image" --format '{{.Id}}')"
[[ ( "$proxy_id" == sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77 || "$proxy_id" == sha256:d76116d819d5162f464b0f2cd09bd28c568a86148c7bc539ce17c33eb22d8bbb || "$proxy_id" == sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229 ) && "$(docker image inspect "$proxy_image" --format '{{.Os}}/{{.Architecture}}')" == linux/amd64 ]] || fail 'Pinned proxy identity or platform differs.'
hostname="${VECTORY_HOSTNAME:-}"; bind="${VECTORY_BIND_IP:-0.0.0.0}"
if [[ -e "$envfile" ]]; then
  regular "$envfile" && [[ "$(wc -c < "$envfile")" -le 65536 ]] || fail 'Retained .env must be bounded and regular.'
  [[ "$(grep -c '^VECTORY_HOSTNAME=' "$envfile")" == 1 && "$(grep -c '^VECTORY_BIND_IP=' "$envfile")" == 1 ]] || fail 'Retained setup is incomplete.'
  stored="$(sed -n 's/^VECTORY_HOSTNAME=//p' "$envfile")"
  [[ -z "$hostname" || "$hostname" == "$stored" ]] || fail 'The hostname cannot replace retained trust.'
  hostname="$stored"; bind="$(sed -n 's/^VECTORY_BIND_IP=//p' "$envfile")"
  [[ -z "${VECTORY_TLS_CERT_FILE:-}${VECTORY_TLS_KEY_FILE:-}" ]] || fail 'Existing trust is retained. Do not supply a replacement pair during a normal restart.'
elif [[ -e "$journal" || -L "$journal" ]]; then
  regular "$journal" && [[ "$(wc -c < "$journal")" -le 8192 ]] || fail 'The setup journal must be bounded and regular.'
  seen='|'; journal_count=0; journal_project=''; journal_host=''; journal_bind=''; journal_server=''; journal_validator=''
  while IFS='=' read -r setting value; do
    [[ "$seen" != *"|$setting|"* && -n "$value" ]] || fail 'The setup journal repeats a setting or has an empty value.'
    seen+="$setting|"; journal_count=$((journal_count+1))
    case "$setting" in VECTORY_SETUP_PROJECT) journal_project="$value" ;; VECTORY_HOSTNAME) journal_host="$value" ;; VECTORY_BIND_IP) journal_bind="$value" ;; VECTORY_SERVER_IMAGE) journal_server="$value" ;; VECTORY_VALIDATOR_IMAGE) journal_validator="$value" ;; *) fail 'Unexpected setup journal setting.' ;; esac
  done < "$journal"
  [[ "$journal_count" == 5 && "$journal_project" == "$project" && "$journal_server" == "$server_image" && "$journal_validator" == "$validator_image" ]] || fail 'Interrupted setup needs its original project and verified image identities.'
  [[ -z "$hostname" || "$hostname" == "$journal_host" ]] || fail 'Resume with the original hostname.'
  hostname="$journal_host"; bind="$journal_bind"
elif [[ -z "$hostname" ]]; then read -r -p 'DNS name pointing to this computer, for example vectory.example.com: ' hostname; fi
[[ "$hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ && "$hostname" != *..* && ! "$hostname" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Enter a DNS name without https://, port or path.'
[[ "$mode" != automatic || "$hostname" == *.* ]] || fail 'Automatic HTTPS needs a public DNS name.'
[[ "$bind" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail 'Use an IPv4 listen address.'
IFS=. read -r -a octets <<< "$bind"; for octet in "${octets[@]}"; do [[ "$((10#$octet))" -le 255 ]] || fail 'Each listen-address octet must be 0 to 255.'; done
printf 'Preparing HTTPS and retained certificate storage...\n'
docker volume create --label io.vectory.server=true "${project}_secrets" >/dev/null
common=(--platform linux/amd64 --rm --network none --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=volume,src=${project}_secrets,dst=/var/lib/vectory")
if [[ "$mode" == custom && ! -e "$envfile" ]]; then
  if [[ ! -e "$journal" ]]; then
    cert="${VECTORY_TLS_CERT_FILE:-}"; key="${VECTORY_TLS_KEY_FILE:-}"
    if [[ -z "$cert" ]]; then read -r -p 'TLS certificate full-chain PEM file (absolute path): ' cert; fi
    if [[ -z "$key" ]]; then read -r -p 'TLS private-key PEM file (absolute path): ' key; fi
    for path in "$cert" "$key"; do
      [[ "$path" == /* && -f "$path" && ! -L "$path" && -r "$path" && "$(wc -c < "$path")" -le 262144 ]] || fail 'Use a bounded readable PEM file at an absolute path, not a link.'
      if LC_ALL=C grep -q '[^[:print:][:space:]]' "$path"; then fail 'Certificate and key must contain ASCII PEM text.'; fi
    done
    retained="$(docker run "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'if test -e /var/lib/vectory/server_cert -o -e /var/lib/vectory/server_key -o -e /var/lib/vectory/bootstrap; then printf retained; fi')"
    [[ -z "$retained" ]] || fail 'This project already holds certificate or setup state. Restore its original .env; trust will not be replaced.'
    docker run -i "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'set -eu; umask 077; test ! -L /var/lib/vectory/server_cert.part; cat > /var/lib/vectory/server_cert.part' < "$cert"
    docker run -i "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'set -eu; umask 077; test ! -L /var/lib/vectory/server_key.part; cat > /var/lib/vectory/server_key.part' < "$key"
    docker run "${common[@]}" --entrypoint /app/operations/vectory-local-pki "$server_image" --server-cert /var/lib/vectory/server_cert.part --server-key /var/lib/vectory/server_key.part --hostname "$hostname"
    [[ ! -L "$journal.part" ]] || fail 'The temporary setup journal must not be a link.'
    (umask 077; printf 'VECTORY_SETUP_PROJECT=%s\nVECTORY_HOSTNAME=%s\nVECTORY_BIND_IP=%s\nVECTORY_SERVER_IMAGE=%s\nVECTORY_VALIDATOR_IMAGE=%s\n' "$project" "$hostname" "$bind" "$server_image" "$validator_image" > "$journal.part")
    mv "$journal.part" "$journal"
  fi
  docker run "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'set -eu; for name in server_cert server_key; do test ! -L "/var/lib/vectory/$name"; if test -e "/var/lib/vectory/$name"; then test -f "/var/lib/vectory/$name"; else test -f "/var/lib/vectory/$name.part"; test ! -L "/var/lib/vectory/$name.part"; mv "/var/lib/vectory/$name.part" "/var/lib/vectory/$name"; fi; done'
fi
if [[ "$mode" == custom ]]; then docker run "${common[@]}" --entrypoint /app/operations/vectory-local-pki "$server_image" --server-cert /var/lib/vectory/server_cert --server-key /var/lib/vectory/server_key --hostname "$hostname"; fi
docker run "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'set -eu; umask 077; test ! -L /var/lib/vectory/bootstrap; if test ! -e /var/lib/vectory/bootstrap; then test ! -L /var/lib/vectory/bootstrap.part; if test -e /var/lib/vectory/bootstrap.part; then test -f /var/lib/vectory/bootstrap.part; rm /var/lib/vectory/bootstrap.part; fi; /app/operations/vectory-local-pki --bootstrap-only --bootstrap /var/lib/vectory/bootstrap.part; mv /var/lib/vectory/bootstrap.part /var/lib/vectory/bootstrap; fi; test -f /var/lib/vectory/bootstrap; test "$(wc -c < /var/lib/vectory/bootstrap)" -eq 65; LC_ALL=C grep -Eq "^[A-Za-z0-9_-]{64}$" /var/lib/vectory/bootstrap'
if [[ "$mode" == automatic ]]; then docker run "${common[@]}" --entrypoint /app/operations/vectory-server-pki "$server_image" --out /var/lib/vectory --hostname "$hostname"; fi
for volume in $(if [[ "$mode" == automatic ]]; then printf 'caddy_data caddy_config'; fi); do
  docker volume create --label io.vectory.server=true "${project}_$volume" >/dev/null
  docker run --platform linux/amd64 --rm --network none --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=volume,src=${project}_$volume,dst=/var/lib/vectory" --entrypoint /bin/sh "$server_image" -c 'set -eu; umask 077; test -w /var/lib/vectory; marker=/var/lib/vectory/.vectory-initialized; test ! -L "$marker"; if test ! -e "$marker"; then (set -C; printf "Vectory managed proxy storage\n" > "$marker"); fi; test -f "$marker"'
done
[[ ! -L "$envfile.part" && ! -e "$envfile.part" ]] || fail 'Inspect the unfinished .env.part before retrying.'
(umask 077; {
  if [[ -f "$envfile" ]]; then awk '/^[[:space:]]*(export[[:space:]]+)?VECTORY_(HOSTNAME|BIND_IP|SERVER_IMAGE|VALIDATOR_IMAGE|PROXY_IMAGE|CERTIFICATE_MODE|SERVER_PROJECT)[[:space:]]*=/ {next} {print}' "$envfile"; fi
  printf 'VECTORY_CERTIFICATE_MODE=%s\nVECTORY_SERVER_PROJECT=%s\nVECTORY_HOSTNAME=%s\nVECTORY_BIND_IP=%s\nVECTORY_SERVER_IMAGE=%s\nVECTORY_VALIDATOR_IMAGE=%s\nVECTORY_PROXY_IMAGE=%s\n' "$mode" "$project" "$hostname" "$bind" "$server_image" "$validator_image" "$proxy_image"
} > "$envfile.part")
mv "$envfile.part" "$envfile"
if regular "$journal"; then rm "$journal"; fi
chmod 0644 "$bundle/Caddyfile.auto" "$bundle/Caddyfile"
[[ ! -L "$bundle/releases" && ( ! -e "$bundle/releases" || -d "$bundle/releases" ) ]] || fail 'The local agent mirror must be an ordinary directory.'
if [[ ! -e "$bundle/releases" ]]; then mkdir -m 0755 "$bundle/releases"; fi
compose config --quiet
printf 'Starting https://%s. Allow inbound TCP 443 and 8443; automatic HTTPS also needs public DNS and TCP 80.\n' "$hostname"
compose up -d --wait --wait-timeout 300
printf 'Open https://%s\n' "$hostname"
status="$(compose exec -T server curl --fail --silent http://127.0.0.1:8080/api/v1/status)"
if [[ "$status" =~ \"initialized\"[[:space:]]*:[[:space:]]*false ]]; then printf 'Create your first administrator using this setup secret:\n'; compose exec -T server cat /run/secrets/bootstrap; fi
printf 'Then choose Add device. Its command includes certificate trust and the verified agent download.\nRetain this kit directory and the Docker data, secrets and Caddy volumes.\n'
