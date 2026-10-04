#!/usr/bin/env bash
# Isolated local development preview for Linux/macOS: loopback dashboard/API,
# verified agent TLS, and the real Vector validator. State stays in .local/.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
preview="${VECTORY_PREVIEW_DIR:-$root/.local/preview}"
web_port="${VECTORY_PREVIEW_WEB_PORT:-8080}"
agent_port="${VECTORY_PREVIEW_AGENT_PORT:-8443}"
validator_port="${VECTORY_PREVIEW_VALIDATOR_PORT:-8081}"
vector_bin="${VECTORY_PREVIEW_VECTOR:-}"
if [[ -z "$vector_bin" ]]; then
  vector_bin="$(find "$root/.local/tools" -path '*/bin/vector' -type f 2>/dev/null | head -n1 || true)"
fi

# A pid file can outlive its process, and after a restart the number can belong
# to an unrelated one: it names this preview's process only while that process
# is this preview's binary.
ours() {
  local pid_file="$preview/$1.pid" pid binary
  [[ -f "$pid_file" ]] || return 1
  pid="$(cat "$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  case "$1" in
    server) binary=vectory-server ;;
    validator) binary=vector-validator ;;
    *) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -q -- "$binary"
}

stop() {
  for name in server validator; do
    local pid_file="$preview/$name.pid"
    if ours "$name"; then
      local pid; pid="$(cat "$pid_file")"
      kill "$pid"
      # Not this shell's child, so `wait` can't: the server answers parked
      # agent waits before it exits and releases its data directory.
      for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    fi
    rm -f "$pid_file"
  done
}

case "${1:-start}" in
  stop) stop; echo "Preview stopped."; exit 0 ;;
  status)
    for name in server validator; do
      if ours "$name"; then
        echo "$name: running (PID $(cat "$preview/$name.pid"))"
      else
        echo "$name: stopped"
      fi
    done
    exit 0 ;;
  restart) stop ;;
  start)
    if ours server; then
      echo "Preview already running at http://127.0.0.1:$web_port (PID $(cat "$preview/server.pid")). Use restart after rebuilding."
      exit 0
    fi ;;
  *) echo "Usage: $0 [start|stop|restart|status]" >&2; exit 2 ;;
esac

mkdir -p "$preview"
chmod 700 "$preview"
# dev-pki creates the folder with a fresh CA and refuses one that exists. A
# partial or expiring set is never replaced here: devices may pin its CA.
pki="$root/.local/pki"
if [[ ! -e "$pki" ]]; then
  (cd "$root" && go run packaging/dev-pki/main.go --out .local/pki --hosts localhost,127.0.0.1,::1)
else
  problem=""
  for file in ca.pem server.pem server-key.pem; do
    [[ -f "$pki/$file" ]] || problem+="${problem:+, }$file is missing"
  done
  if [[ -z "$problem" ]] && command -v openssl >/dev/null && ! openssl x509 -checkend 3600 -noout -in "$pki/server.pem" >/dev/null 2>&1; then
    problem="server.pem expires within the hour or has expired (dev-pki certificates last 7 days)"
  fi
  if [[ -n "$problem" ]]; then
    echo "The development PKI in $pki can't be used: $problem." >&2
    echo "Move it aside and start again to create a new CA and certificate: mv '$pki' '$pki.old'" >&2
    echo "Devices enrolled against the old CA then need enrolling again." >&2
    exit 1
  fi
fi
# The agent listener presents its CA after the server certificate (a full
# chain), so Add device can offer a CA pin that devices check.
chain="$preview/agent-chain.pem"
if [[ "$(grep -c 'BEGIN CERTIFICATE' "$root/.local/pki/server.pem")" == 1 ]]; then
  cat "$root/.local/pki/server.pem" "$root/.local/pki/ca.pem" > "$chain"
else
  cp "$root/.local/pki/server.pem" "$chain"
fi

# Agents bundled with this preview, as the server image bundles them. Rebuilt
# when agent sources change; VECTORY_PREVIEW_AGENT_TARGETS (for example
# "linux/amd64 darwin/arm64") limits the platforms for a faster start.
bundled="$preview/agent-releases"
if [[ ! -f "$bundled/catalog.json" || -n "$(find "$root/agent" -name '*.go' -newer "$bundled/catalog.json" | head -n1)" ]]; then
  if command -v go >/dev/null && command -v python3 >/dev/null; then
    targets=()
    for target in ${VECTORY_PREVIEW_AGENT_TARGETS:-}; do targets+=(--target "$target"); done
    echo "Building bundled agents into $bundled..."
    rm -rf "$bundled"
    python3 "$root/packaging/build-release.py" --no-archives --out "$bundled" ${targets[@]+"${targets[@]}"} >/dev/null
  else
    echo "Go or Python 3 is missing; the preview has no bundled agents." >&2
    echo "Add device cannot install an agent. Install Go 1.26 and Python 3.11 or newer, then restart the preview to build agent downloads." >&2
  fi
fi
if [[ ! -f "$preview/bootstrap.secret" ]]; then
  (umask 077 && head -c 48 /dev/urandom | base64 | tr -d '\n' > "$preview/bootstrap.secret")
fi

server_bin="$root/server/target/debug/vectory-server"
validator_bin="$root/server/target/debug/vector-validator"
[[ -x "$server_bin" ]] || { echo "Build the server first: (cd server && cargo build --bins)" >&2; exit 1; }

validation_url=""
if [[ -n "$vector_bin" && -x "$validator_bin" ]]; then
  VECTORY_VALIDATOR_ISOLATED=true \
  VECTORY_VECTOR_BINARY="$vector_bin" \
  VECTORY_VALIDATOR_ADDR="127.0.0.1:$validator_port" \
    NO_COLOR=1 nohup "$validator_bin" >>"$preview/validator.log" 2>&1 &
  echo $! > "$preview/validator.pid"
  validation_url="http://127.0.0.1:$validator_port"
else
  echo "No Vector binary found under .local/tools; checks run structurally only." >&2
fi

export VECTORY_DATA_DIR="$preview/state"
export VECTORY_DEVELOPMENT=true
export VECTORY_COOKIE_SECURE=false
export VECTORY_BOOTSTRAP_SECRET_FILE="$preview/bootstrap.secret"
export VECTORY_TLS_CERT="$chain"
export VECTORY_TLS_KEY="$root/.local/pki/server-key.pem"
export VECTORY_HTTP_ADDR="127.0.0.1:$web_port"
export VECTORY_AGENT_ADDR="127.0.0.1:$agent_port"
export VECTORY_PUBLIC_URL="http://127.0.0.1:$web_port"
export VECTORY_DASHBOARD_DIR="$root/dashboard/dist"
export VECTORY_BUNDLED_RELEASES_DIR="$bundled"
# An optional operator mirror; its builds replace bundled ones per platform.
export VECTORY_RELEASES_DIR="${VECTORY_RELEASES_DIR:-$preview/release-mirror}"
export VECTORY_INSTANCE_NAME="${VECTORY_INSTANCE_NAME:-Local preview}"
[[ -n "$validation_url" ]] && export VECTORY_VALIDATION_URL="$validation_url"
mkdir -p "$VECTORY_RELEASES_DIR"
NO_COLOR=1 nohup "$server_bin" >>"$preview/server.log" 2>&1 &
echo $! > "$preview/server.pid"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$web_port/api/v1/status" >/dev/null 2>&1; then
    echo "Preview running at http://127.0.0.1:$web_port (agent TLS https://127.0.0.1:$agent_port)."
    echo "Bootstrap secret: $preview/bootstrap.secret"
    echo "Add a device from Devices > Add device. The server log ($preview/server.log) shows only the ends of the CA fingerprint; Add device shows all of it."
    exit 0
  fi
  sleep 0.5
done
echo "Server did not become ready; see $preview/server.log" >&2
exit 1
