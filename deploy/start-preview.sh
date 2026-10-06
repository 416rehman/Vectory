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
compose() { docker compose --project-name "$project" --env-file "$envfile" -f "$bundle/compose.yaml" "$@"; }

if [[ "$action" != start ]]; then
  [[ -f "$envfile" && ! -L "$envfile" ]] || fail "This preview has not started yet. Run ./start.sh first."
  case "$action" in
    stop) compose stop; say "Preview stopped. Your workspace and device trust are retained. Run ./start.sh to resume." ;;
    status) compose ps ;;
    setup-secret) [[ -f setup-secret.txt && ! -L setup-secret.txt ]] || fail "Run ./start.sh to restore your local setup-secret.txt."; cat setup-secret.txt ;;
  esac
  exit 0
fi

ports=("${VECTORY_PREVIEW_WEB_PORT:-8080}" "${VECTORY_PREVIEW_AGENT_PORT:-8443}" "${VECTORY_PREVIEW_VALIDATOR_PORT:-18081}")
for port in "${ports[@]}"; do [[ "$port" =~ ^[0-9]{1,5}$ && "$port" -ge 1024 && "$port" -le 65535 ]] || fail "Preview ports must be integers from 1024 to 65535."; done
[[ "${ports[0]}" != "${ports[1]}" && "${ports[0]}" != "${ports[2]}" && "${ports[1]}" != "${ports[2]}" ]] || fail "Each preview service needs a different port."
source "$bundle/release-images.sh"
load_release_images
# This file contains configuration only. Secrets stay in Docker's pki volume.
[[ ! -L "$envfile" ]] || fail "The preview environment file must not be a link."
(umask 077; printf 'VECTORY_PREVIEW_SERVER_IMAGE=%s\nVECTORY_PREVIEW_VALIDATOR_IMAGE=%s\nVECTORY_PREVIEW_WEB_PORT=%s\nVECTORY_PREVIEW_AGENT_PORT=%s\nVECTORY_PREVIEW_VALIDATOR_PORT=%s\n' "$server_image" "$validator_image" "${ports[@]}" > "$envfile")
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
say "Starting Vectory and its isolated Vector validator..."
if ! compose up -d --wait --wait-timeout 180; then
  compose logs --no-color --tail 40
  fail "A preview service did not become healthy. Check for ports already in use; ./start.sh stop safely stops this preview."
fi
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
