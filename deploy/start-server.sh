#!/usr/bin/env bash
# Guided server startup using verified release images, without source builds.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
bundle="$(pwd -P)"
fail() { printf 'Vectory: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
action="${1:-start}"
[[ $# -le 1 ]] || fail "Usage: ./start.sh [start|stop|status|setup-secret]"
case "$action" in start|stop|status|setup-secret) ;; *) fail "Usage: ./start.sh [start|stop|status|setup-secret]" ;; esac
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail "This server kit supports Linux x86-64."
for tool in docker sha256sum; do command -v "$tool" >/dev/null || fail "Install $tool, then run ./start.sh again."; done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required. Install the Compose plugin."
docker info >/dev/null 2>&1 || fail "Docker is not reachable. Start Docker Engine and check that your account can run docker info."
[[ "$(docker info --format '{{.OSType}}/{{.Architecture}}')" =~ ^linux/(x86_64|amd64)$ ]] || fail "The Docker daemon must run Linux x86-64 containers."
declare -A seen=()
[[ -f SHA256SUMS && ! -L SHA256SUMS ]] || fail "No regular bundle SHA256SUMS file. Download the kit again."
while read -r checksum name extra; do
  [[ "$checksum" =~ ^[0-9a-f]{64}$ && -z "${extra:-}" ]] || fail "Malformed kit checksum inventory."
  case "$name" in start.sh|release-images.sh|compose.yaml|Caddyfile|.env.example|README.md|LICENSE|NOTICE|VERSION) ;; *) fail "Unexpected kit checksum entry." ;; esac
  [[ -z "${seen[$name]:-}" && -f "$name" && ! -L "$name" ]] || fail "Missing, repeated or linked bundle file: $name"
  seen[$name]=1
done < SHA256SUMS
[[ ${#seen[@]} == 9 ]] || fail "The server kit is incomplete. Download it again."
sha256sum --check --strict SHA256SUMS >/dev/null || fail "Server kit checksum failed. Download it again."
version="$(cat VERSION)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail "Invalid bundled version."
project="${VECTORY_SERVER_PROJECT:-vectory}"
[[ "$project" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || fail "VECTORY_SERVER_PROJECT must be 1 to 40 lowercase letters, digits or hyphens."
export VECTORY_SERVER_PROJECT="$project"
envfile="$bundle/.env"
journal="$bundle/.setup.env"
compose() { docker compose --project-name "$project" --env-file "$envfile" -f "$bundle/compose.yaml" "$@"; }
common=(--rm --network none --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=volume,src=${project}_secrets,dst=/var/lib/vectory")
check_bind() {
  [[ "$bind" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "Enter an IPv4 bind address (0.0.0.0 listens on all interfaces)."
  IFS=. read -r -a octets <<< "$bind"
  for octet in "${octets[@]}"; do [[ "$((10#$octet))" -le 255 ]] || fail "Each bind-address octet must be 0 to 255."; done
}
finish_setup() {
  # A journal is written only after the supplied pair has passed validation.
  # Keep each committed file; a retry can finish the other rename without
  # replacing either the certificate identity or an existing setup secret.
  docker run "${common[@]}" --entrypoint /bin/sh "$server_image" -c '
    set -eu
    for name in server_cert server_key; do
      test ! -L "/var/lib/vectory/$name"
      if test -e "/var/lib/vectory/$name"; then
        test -f "/var/lib/vectory/$name"
      else
        test -f "/var/lib/vectory/$name.part" && test ! -L "/var/lib/vectory/$name.part"
        mv "/var/lib/vectory/$name.part" "/var/lib/vectory/$name"
      fi
    done'
  docker run "${common[@]}" --entrypoint /app/operations/vectory-local-pki "$server_image" --server-cert /var/lib/vectory/server_cert --server-key /var/lib/vectory/server_key --hostname "$hostname"
  docker run "${common[@]}" --entrypoint /bin/sh "$server_image" -c '
    set -eu
    umask 077
    test ! -L /var/lib/vectory/bootstrap
    if test ! -e /var/lib/vectory/bootstrap; then
      test ! -L /var/lib/vectory/bootstrap.part
      if test -e /var/lib/vectory/bootstrap.part; then
        test -f /var/lib/vectory/bootstrap.part
        rm /var/lib/vectory/bootstrap.part
      fi
      /app/operations/vectory-local-pki --bootstrap-only --bootstrap /var/lib/vectory/bootstrap.part
      mv /var/lib/vectory/bootstrap.part /var/lib/vectory/bootstrap
    fi
    test -f /var/lib/vectory/bootstrap
    test "$(wc -c < /var/lib/vectory/bootstrap)" -eq 65
    LC_ALL=C grep -Eq "^[A-Za-z0-9_-]{64}$" /var/lib/vectory/bootstrap'
  [[ ! -L "$envfile.part" && ( ! -e "$envfile.part" || -f "$envfile.part" ) ]] || fail "The temporary server environment file must be regular."
  (umask 077; printf 'VECTORY_HOSTNAME=%s\nVECTORY_BIND_IP=%s\nVECTORY_SERVER_IMAGE=%s\nVECTORY_VALIDATOR_IMAGE=%s\n' "$hostname" "$bind" "$server_image" "$validator_image" > "$envfile.part")
  mv -- "$envfile.part" "$envfile"
  rm -- "$journal"
}
if [[ "$action" != start ]]; then
  [[ -f "$envfile" && ! -L "$envfile" ]] || fail "Run ./start.sh first."
  case "$action" in
    stop) compose stop; say "Server stopped. Database and certificate volumes are retained." ;;
    status) compose ps ;;
    setup-secret) compose exec -T server cat /run/secrets/bootstrap ;;
  esac
  exit 0
fi
source "$bundle/release-images.sh"
load_release_images

if [[ -f "$envfile" && ! -L "$envfile" ]]; then
  # Read the stored name without executing an environment file as shell code.
  hostname="$(sed -n 's/^VECTORY_HOSTNAME=//p' "$envfile")"
  [[ "$hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || fail ".env has no safe VECTORY_HOSTNAME; use the installation guide."
  say "Resuming the server at https://$hostname using its retained certificate and database."
elif [[ -f "$journal" && ! -L "$journal" ]]; then
  [[ ! -e "$envfile" && ! -L "$envfile" ]] || fail "The server environment file must be regular."
  # Parse exactly our five nonsecret settings, never execute a journal as code.
  declare -A setup=()
  while IFS='=' read -r setting value; do
    case "$setting" in VECTORY_SETUP_PROJECT|VECTORY_HOSTNAME|VECTORY_BIND_IP|VECTORY_SERVER_IMAGE|VECTORY_VALIDATOR_IMAGE) ;; *) fail "Malformed setup journal; restore its original contents before retrying." ;; esac
    [[ -z "${setup[$setting]:-}" && -n "$value" ]] || fail "Malformed setup journal; restore its original contents before retrying."
    setup[$setting]="$value"
  done < "$journal"
  [[ ${#setup[@]} == 5 && "${setup[VECTORY_SETUP_PROJECT]}" == "$project" ]] || fail "Use the original VECTORY_SERVER_PROJECT to resume this setup journal."
  hostname="${setup[VECTORY_HOSTNAME]}"
  bind="${setup[VECTORY_BIND_IP]}"
  [[ "$hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || fail "The setup journal has an unsafe hostname."
  check_bind
  [[ "${setup[VECTORY_SERVER_IMAGE]}" == "$server_image" && "${setup[VECTORY_VALIDATOR_IMAGE]}" == "$validator_image" ]] || fail "The setup journal needs its original verified release images."
  say "Finishing interrupted first setup at https://$hostname using its retained certificate."
  finish_setup
else
  [[ ! -e "$envfile" && ! -L "$envfile" && ! -e "$journal" && ! -L "$journal" ]] || fail "The server environment and setup journal must be regular files."
  hostname="${VECTORY_HOSTNAME:-}"
  cert="${VECTORY_TLS_CERT_FILE:-}"
  key="${VECTORY_TLS_KEY_FILE:-}"
  bind="${VECTORY_BIND_IP:-}"
  if [[ -z "$hostname" ]]; then read -r -p 'Server DNS name (for example vectory.example.com): ' hostname; fi
  [[ "$hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || fail "Enter a bare DNS name without https://, a port or a path."
  [[ ! "$hostname" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Use the server's DNS name for HTTPS certificate selection, rather than an IP address."
  if [[ -z "$cert" ]]; then read -r -p 'TLS certificate full-chain PEM file (absolute path): ' cert; fi
  if [[ -z "$key" ]]; then read -r -p 'TLS private-key PEM file (absolute path): ' key; fi
  for path in "$cert" "$key"; do [[ "$path" == /* && -f "$path" && ! -L "$path" && -r "$path" ]] || fail "Use a readable regular PEM file at an absolute path; the starter does not follow certificate links."; done
  if [[ -z "$bind" ]]; then read -r -p 'Listen address for dashboard 443 and agent 8443 [0.0.0.0 = all interfaces]: ' bind; bind="${bind:-0.0.0.0}"; fi
  check_bind
  say "Checking your certificate for $hostname; no host trust store will be changed."
  docker volume create --label io.vectory.server=true "${project}_secrets" >/dev/null
  if docker run "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'test -e /var/lib/vectory/server_cert -o -e /var/lib/vectory/server_key -o -e /var/lib/vectory/bootstrap'; then
    fail "This project already has certificate or setup state. Restore its original .env before resuming; the starter will not replace existing trust."
  fi
  docker run -i "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'umask 077; cat > /var/lib/vectory/server_cert.part' < "$cert"
  docker run -i "${common[@]}" --entrypoint /bin/sh "$server_image" -c 'umask 077; cat > /var/lib/vectory/server_key.part' < "$key"
  docker run "${common[@]}" --entrypoint /app/operations/vectory-local-pki "$server_image" --server-cert /var/lib/vectory/server_cert.part --server-key /var/lib/vectory/server_key.part --hostname "$hostname" || fail "Certificate check failed. Correct the PEM files and run ./start.sh again."
  [[ ! -L "$journal.part" && ( ! -e "$journal.part" || -f "$journal.part" ) ]] || fail "The temporary setup journal must be regular."
  (umask 077; printf 'VECTORY_SETUP_PROJECT=%s\nVECTORY_HOSTNAME=%s\nVECTORY_BIND_IP=%s\nVECTORY_SERVER_IMAGE=%s\nVECTORY_VALIDATOR_IMAGE=%s\n' "$project" "$hostname" "$bind" "$server_image" "$validator_image" > "$journal.part")
  mv -- "$journal.part" "$journal"
  finish_setup
fi
docker run "${common[@]}" --entrypoint /app/operations/vectory-local-pki "$server_image" --server-cert /var/lib/vectory/server_cert --server-key /var/lib/vectory/server_key --hostname "$hostname"
mkdir -p releases
compose config --quiet
say "Starting the server, TLS proxy and isolated Vector validator..."
if ! compose up -d --wait --wait-timeout 300; then
  compose logs --no-color --tail 40
  fail "A service did not become healthy. Review the logs and ports 443/8443. ./start.sh stop stops this project safely."
fi
say ""
say "Open https://$hostname"
status="$(compose exec -T server curl --fail --silent http://127.0.0.1:8080/api/v1/status)"
if [[ "$status" =~ \"initialized\"[[:space:]]*:[[:space:]]*false ]]; then
  say "Create your first administrator using this setup secret (shown only while setup is incomplete):"
  compose exec -T server cat /run/secrets/bootstrap
fi
say "Then choose Add device to connect a host running Vector."
say "Back up both ${project}_data and ${project}_secrets. Stop: ./start.sh stop"
