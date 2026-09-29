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

stop() {
  for name in server validator; do
    local pid_file="$preview/$name.pid"
    if [[ -f "$pid_file" ]]; then
      local pid; pid="$(cat "$pid_file")"
      if kill -0 "$pid" 2>/dev/null; then kill "$pid"; wait "$pid" 2>/dev/null || true; fi
      rm -f "$pid_file"
    fi
  done
}

case "${1:-start}" in
  stop) stop; echo "Preview stopped."; exit 0 ;;
  status)
    for name in server validator; do
      if [[ -f "$preview/$name.pid" ]] && kill -0 "$(cat "$preview/$name.pid")" 2>/dev/null; then
        echo "$name: running (PID $(cat "$preview/$name.pid"))"
      else
        echo "$name: stopped"
      fi
    done
    exit 0 ;;
  restart) stop ;;
  start)
    if [[ -f "$preview/server.pid" ]] && kill -0 "$(cat "$preview/server.pid")" 2>/dev/null; then
      echo "Preview already running at http://127.0.0.1:$web_port (PID $(cat "$preview/server.pid")). Use restart after rebuilding."
      exit 0
    fi ;;
  *) echo "Usage: $0 [start|stop|restart|status]" >&2; exit 2 ;;
esac

mkdir -p "$preview"
chmod 700 "$preview"
if [[ ! -f "$root/.local/pki/server.pem" ]]; then
  (cd "$root" && go run packaging/dev-pki/main.go --out .local/pki --hosts localhost,127.0.0.1,::1)
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
    nohup "$validator_bin" >"$preview/validator.log" 2>&1 &
  echo $! > "$preview/validator.pid"
  validation_url="http://127.0.0.1:$validator_port"
else
  echo "No Vector binary found under .local/tools; checks run structurally only." >&2
fi

export VECTORY_DATA_DIR="$preview/state"
export VECTORY_DEVELOPMENT=true
export VECTORY_COOKIE_SECURE=false
export VECTORY_BOOTSTRAP_SECRET_FILE="$preview/bootstrap.secret"
export VECTORY_TLS_CERT="$root/.local/pki/server.pem"
export VECTORY_TLS_KEY="$root/.local/pki/server-key.pem"
export VECTORY_HTTP_ADDR="127.0.0.1:$web_port"
export VECTORY_AGENT_ADDR="127.0.0.1:$agent_port"
export VECTORY_DASHBOARD_DIR="$root/dashboard/dist"
export VECTORY_RELEASES_DIR="${VECTORY_RELEASES_DIR:-$root/artifacts/releases}"
export VECTORY_INSTANCE_NAME="${VECTORY_INSTANCE_NAME:-Local preview}"
[[ -n "$validation_url" ]] && export VECTORY_VALIDATION_URL="$validation_url"
mkdir -p "$VECTORY_RELEASES_DIR"
nohup "$server_bin" >"$preview/server.log" 2>&1 &
echo $! > "$preview/server.pid"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$web_port/api/v1/status" >/dev/null 2>&1; then
    echo "Preview running at http://127.0.0.1:$web_port (agent TLS https://localhost:$agent_port)."
    echo "Bootstrap secret: $preview/bootstrap.secret"
    exit 0
  fi
  sleep 0.5
done
echo "Server did not become ready; see $preview/server.log" >&2
exit 1
