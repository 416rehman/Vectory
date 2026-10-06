#!/usr/bin/env bash
# A disposable CI check of real keyless verification and transported image bytes.
set -euo pipefail
[[ $# == 2 ]] || { echo 'Usage: verify-offline-release.sh RELEASE_DIR NEW_WORK_DIR' >&2; exit 1; }
release_dir="$(cd -- "$1" && pwd -P)"
work="$2"
[[ ! -e "$work" && ! -L "$work" ]] || { echo 'Use a new fixture directory.' >&2; exit 1; }
version="$(sed -n 's/^const Version = "\([^"]*\)"$/\1/p' agent/internal/agent/types.go)"
mkdir -m 0700 -- "$work"
tar -xzf "$release_dir/vectory-$version-server-linux-amd64.tar.gz" -C "$work"
kit="$work/vectory-$version-server-linux-amd64"
VECTORY_RELEASE_DIR="$release_dir" "$kit/prepare-offline.sh" "$work/airgap-kit"
bundle="$work/airgap-kit"
for name in cosign proxy vectory-server vectory-validator; do docker load --input "$bundle/.cache/$name-image.tar.gz" >/dev/null; done
(
  cd -- "$bundle"
  fail() { printf '%s\n' "$*" >&2; exit 1; }
  say() { :; }
  export VECTORY_OFFLINE=true
  source ./verify-release.sh
  load_signed_images
  [[ "$server_image" =~ ^sha256:[a-f0-9]{64}$ && "$validator_image" =~ ^sha256:[a-f0-9]{64}$ && "$proxy_image" =~ ^sha256:[a-f0-9]{64}$ ]]
  # Parsing the exact delivered template proves Docker will never need a pull.
  printf 'VECTORY_HOSTNAME=vectory.example.test\nVECTORY_BIND_IP=127.0.0.1\nVECTORY_SERVER_IMAGE=%s\nVECTORY_VALIDATOR_IMAGE=%s\nVECTORY_PROXY_IMAGE=%s\n' "$server_image" "$validator_image" "$proxy_image" > .env
  docker compose --env-file .env -f compose.yaml config --format json > compose.json
  python3 - <<'PY'
import json
from pathlib import Path
services = json.loads(Path('compose.json').read_text())['services']
assert all(service['pull_policy'] == 'never' for service in services.values())
assert all(service['image'].startswith('sha256:') for service in services.values())
PY
)
echo 'Real signed offline preparation, transferred image bytes and network-isolated proof verification passed. No manager or device was activated.'
