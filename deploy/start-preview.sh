#!/usr/bin/env bash
# Start the prebuilt local preview without compiling or changing host services.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
bundle="$(pwd -P)"
fail() { printf 'Vectory: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
action="${1:-start}"
[[ $# -le 1 ]] || fail "Usage: ./start.sh [start|stop|status|setup-secret]"
case "$action" in start|stop|status|setup-secret) ;; *) fail "Usage: ./start.sh [start|stop|status|setup-secret]" ;; esac
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail "This preview supports Linux x86-64. Use the server installation guide for other hosts."
for tool in docker sha256sum; do command -v "$tool" >/dev/null || fail "Install $tool, then run ./start.sh again."; done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required. Install the Compose plugin, then run ./start.sh again."
docker info >/dev/null 2>&1 || fail "Docker is not reachable. Start Docker Engine and make sure your account can run docker info."
[[ "$(docker info --format '{{.OSType}}/{{.Architecture}}')" =~ ^linux/(x86_64|amd64)$ ]] || fail "The Docker daemon must run Linux x86-64 containers."

# Verify the complete, fixed bundle before using configuration or downloading.
declare -A seen=()
[[ -f SHA256SUMS && ! -L SHA256SUMS ]] || fail "The preview bundle has no regular SHA256SUMS file. Download it again."
while read -r checksum name extra; do
  [[ "$checksum" =~ ^[0-9a-f]{64}$ && -z "${extra:-}" ]] || fail "Malformed bundle checksum inventory. Download the bundle again."
  case "$name" in start.sh|release-images.sh|compose.yaml|README.md|LICENSE|NOTICE|VERSION) ;; *) fail "Unexpected bundle checksum entry." ;; esac
  [[ -z "${seen[$name]:-}" && -f "$name" && ! -L "$name" ]] || fail "Missing, repeated or linked bundle file: $name"
  seen[$name]=1
done < SHA256SUMS
[[ ${#seen[@]} == 7 ]] || fail "The preview bundle is incomplete. Download it again."
sha256sum --check --strict SHA256SUMS >/dev/null || fail "Preview bundle checksum failed. Download it again."
version="$(cat VERSION)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail "Invalid bundled version."
project="${VECTORY_PREVIEW_PROJECT:-vectory-preview}"
[[ "$project" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || fail "VECTORY_PREVIEW_PROJECT must be 1 to 40 lowercase letters, digits or hyphens."
export VECTORY_PREVIEW_PROJECT="$project"
envfile="$bundle/.preview.env"
compose() {
  # The checked file is authoritative. Compose otherwise gives inherited shell
  # values precedence, including stale image tags or ports on a later stop.
  (
    unset VECTORY_PREVIEW_SERVER_IMAGE VECTORY_PREVIEW_VALIDATOR_IMAGE
    unset VECTORY_PREVIEW_WEB_PORT VECTORY_PREVIEW_AGENT_PORT
    unset VECTORY_PREVIEW_VALIDATION_URL VECTORY_PREVIEW_NO_PROXY
    docker compose --project-name "$project" --env-file "$envfile" -f "$bundle/compose.yaml" "$@"
  )
}

if [[ "$action" != start ]]; then
  [[ -f "$envfile" && ! -L "$envfile" ]] || fail "This preview has not started yet. Run ./start.sh first."
  case "$action" in
    stop) compose stop; say "Preview stopped. Your workspace and device trust are retained. Run ./start.sh to resume." ;;
    status) compose ps ;;
    setup-secret) [[ -f setup-secret.txt && ! -L setup-secret.txt ]] || fail "Run ./start.sh to restore your local setup-secret.txt."; cat setup-secret.txt ;;
  esac
  exit 0
fi

ports=("${VECTORY_PREVIEW_WEB_PORT:-8080}" "${VECTORY_PREVIEW_AGENT_PORT:-8443}")
for port in "${ports[@]}"; do [[ "$port" =~ ^[0-9]{1,5}$ && "$port" -ge 1024 && "$port" -le 65535 ]] || fail "Preview ports must be integers from 1024 to 65535."; done
[[ "${ports[0]}" != "${ports[1]}" ]] || fail "The web and agent services need different ports."
source "$bundle/release-images.sh"
load_release_images
# This file contains configuration only. Secrets stay in Docker's pki volume.
write_env() {
  [[ ! -L "$envfile" && ! -L "$envfile.part" ]] || fail "The preview environment file must not be a link."
  (umask 077; printf 'VECTORY_PREVIEW_SERVER_IMAGE=%s\nVECTORY_PREVIEW_VALIDATOR_IMAGE=%s\nVECTORY_PREVIEW_WEB_PORT=%s\nVECTORY_PREVIEW_AGENT_PORT=%s\nVECTORY_PREVIEW_VALIDATION_URL=%s\nVECTORY_PREVIEW_NO_PROXY=%s\n' "$server_image" "$validator_image" "${ports[@]}" "$1" "$2" > "$envfile.part")
  mv -- "$envfile.part" "$envfile"
}
# Compose parses every service even when starting only the validator. The
# temporary endpoint fails closed; the server is not started until it is replaced.
write_env http://127.0.0.1:9 localhost,127.0.0.1,::1
compose config --quiet
say "Preparing private local device trust..."
docker volume create --label io.vectory.preview=true "${project}_pki" >/dev/null
# Mounting at the image's pre-owned data path initializes volume ownership to
# 10001. The helper runs without root and refuses to replace retained trust.
common=(--rm --network none --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=volume,src=${project}_pki,dst=/var/lib/vectory")
if docker run "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'test -d /var/lib/vectory/pki'; then
  docker run "${common[@]}" --entrypoint /app/operations/vectory-local-pki "$server_image" --out /var/lib/vectory/pki --bootstrap /var/lib/vectory/bootstrap --check || fail "Retained preview trust needs attention. Read README.md; the starter will not replace a CA your devices trust."
else
  docker run "${common[@]}" --entrypoint /app/operations/vectory-local-pki "$server_image" --out /var/lib/vectory/pki --bootstrap /var/lib/vectory/bootstrap --hosts localhost,127.0.0.1 --days 7
fi
# The chain is derived from checked, retained trust. Rebuild it atomically on
# every start, including a retry interrupted after the original PKI generation.
docker run "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'set -eu; umask 077; cat /var/lib/vectory/pki/server.pem /var/lib/vectory/pki/ca.pem > /var/lib/vectory/pki/agent-chain.pem.part; mv /var/lib/vectory/pki/agent-chain.pem.part /var/lib/vectory/pki/agent-chain.pem'
for exported in ca.pem setup-secret.txt; do [[ ! -L "$bundle/$exported" ]] || fail "Refusing linked local $exported."; done
(umask 077; docker run "${common[@]}" --entrypoint cat "$server_image" /var/lib/vectory/pki/ca.pem > "$bundle/ca.pem")
(umask 077; docker run "${common[@]}" --entrypoint cat "$server_image" /var/lib/vectory/bootstrap > "$bundle/setup-secret.txt")
chmod 600 "$bundle/setup-secret.txt"
say "Starting the isolated Vector validator..."
if ! compose up -d --no-deps --wait --wait-timeout 180 validator; then
  compose logs --no-color --tail 40 validator
  fail "The isolated validator did not become healthy. Run ./start.sh again after checking the error."
fi
# Docker 29 may accept an internal-only published port but never install its
# host mapping. Reach only this project's checked internal bridge endpoint.
validator_id="$(compose ps -q validator)"
[[ "$validator_id" =~ ^[0-9a-f]{64}$ ]] || fail "Expected exactly one validator container owned by this preview."
owner="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Image}}' "$validator_id")" || fail "The preview validator could not be inspected."
IFS='|' read -r owner_project owner_service worker_image extra <<< "$owner"
[[ "$owner_project" == "$project" && "$owner_service" == validator && -z "${extra:-}" ]] || fail "The validator is not owned by this preview's Compose project."
expected_image="$(docker image inspect --format '{{.Id}}' "$validator_image")" || fail "The verified validator image is unavailable."
[[ "$expected_image" =~ ^sha256:[0-9a-f]{64}$ && "$worker_image" == "$expected_image" ]] || fail "The validator is running a different image."
published="$(docker inspect --format '{{len .HostConfig.PortBindings}}|{{range .NetworkSettings.Ports}}{{if .}}published{{end}}{{end}}' "$validator_id")" || fail "The validator's port bindings could not be inspected."
[[ "$published" == '0|' ]] || fail "The isolated validator must not publish a host port."
network="${project}_validation"
details="$(docker network inspect --format '{{.Id}}|{{.Internal}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}|{{.Driver}}' "$network")" || fail "The preview's isolated validation network is unavailable."
IFS='|' read -r network_id internal network_project network_service driver extra <<< "$details"
[[ "$network_id" =~ ^[0-9a-f]{64}$ && "$internal" == true && "$network_project" == "$project" && "$network_service" == validation && "$driver" == bridge && -z "${extra:-}" ]] || fail "The validator network is not this preview's isolated bridge."
template="{{(index .NetworkSettings.Networks \"$network\").NetworkID}}|{{(index .NetworkSettings.Networks \"$network\").IPAddress}}|{{len .NetworkSettings.Networks}}"
endpoint="$(docker inspect --format "$template" "$validator_id")" || fail "The validator has no endpoint on its isolated network."
IFS='|' read -r endpoint_network validator_ip network_count extra <<< "$endpoint"
[[ "$endpoint_network" == "$network_id" && "$network_count" == 1 && -z "${extra:-}" && "$validator_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "The validator must have one IPv4 endpoint on its own isolated network."
IFS='.' read -r -a octets <<< "$validator_ip"
for octet in "${octets[@]}"; do [[ "$octet" == 0 || "$octet" != 0* ]] && ((10#$octet <= 255)) || fail "The validator returned an invalid IPv4 address."; done
((10#${octets[0]} > 0 && 10#${octets[0]} < 224 && 10#${octets[0]} != 127)) || fail "The validator returned an unusable internal IPv4 address."
validation_url="http://$validator_ip:8081"
write_env "$validation_url" "localhost,127.0.0.1,::1,$validator_ip"
compose config --quiet
say "Starting Vectory..."
if ! compose up -d --wait --wait-timeout 180; then
  compose logs --no-color --tail 40
  fail "A preview service did not become healthy. Check for ports already in use; ./start.sh stop safely stops this preview."
fi
worker_health="$(compose exec -T server curl --noproxy '*' --fail --silent --max-time 10 "$validation_url/health")" || fail "Vectory cannot reach its isolated validator. Run ./start.sh again; success has not been reported."
[[ "$worker_health" =~ \"status\"[[:space:]]*:[[:space:]]*\"ok\" && "$worker_health" =~ \"vector_version\"[[:space:]]*:[[:space:]]*\"0\.58\.0\" && "$worker_health" =~ \"worker_protocol\"[[:space:]]*:[[:space:]]*2([,}\ \t\r\n]|$) ]] || fail "The isolated validator returned an unexpected version or protocol."
say ""
say "Open http://127.0.0.1:${ports[0]}"
status="$(compose exec -T server curl --fail --silent "http://127.0.0.1:${ports[0]}/api/v1/status")"
if [[ "$status" =~ \"initialized\"[[:space:]]*:[[:space:]]*false ]]; then
  say "Create your administrator using this setup secret (shown only while setup is incomplete):"
  cat "$bundle/setup-secret.txt"
fi
say "Then choose Add device. Your local public CA is $bundle/ca.pem"
say "Stop: ./start.sh stop   Resume: ./start.sh"
say "This seven-day preview stays on this Linux host. No host service or trust store was changed."
