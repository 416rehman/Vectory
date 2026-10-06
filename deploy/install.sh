#!/usr/bin/env bash
# Download, verify and start the official server kit. No root or compiler needed.
set -euo pipefail
version='0.2.1'
fail() { printf 'Vectory: %s\n' "$*" >&2; exit 1; }
[[ $# -le 1 ]] || fail 'Usage: bash vectory-install.sh [server.example.com]'
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || fail 'The manager needs a Linux x86-64 Docker host. Agents are available separately for Linux, macOS and Windows.'
for tool in docker curl tar sha256sum; do command -v "$tool" >/dev/null || fail "Install $tool, then retry."; done
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
docker info >/dev/null 2>&1 || fail 'Start Docker Engine and check that your account can run docker info.'
[[ "$(docker info --format '{{.OSType}}/{{.Architecture}}')" =~ ^linux/(amd64|x86_64)$ ]] || fail 'The Docker daemon must run Linux x86-64 containers.'
target="${VECTORY_INSTALL_DIRECTORY:-$PWD/vectory}"
[[ ! -L "$target" ]] || fail 'The installation directory must not be a link.'
if [[ -e "$target" ]]; then
  [[ -d "$target" && -z "$(ls -A -- "$target")" ]] || fail 'Choose an empty installation directory, or use the retained installation start.sh to resume it.'
fi
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
release="https://github.com/416rehman/Vectory/releases/download/v$version"
kit="vectory-$version-server-linux-amd64"
archive="$kit.tar.gz"
for name in SHA256SUMS SHA256SUMS.sigstore.json IMAGE-DIGESTS.env "$archive"; do
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 300 "$release/$name" -o "$temporary/$name" || fail "Could not download $name. Nothing was installed."
done
printf 'Verifying the official Vectory %s release...\n' "$version"
docker run --rm --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --env HOME=/tmp --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,src=$temporary,dst=/release,readonly" \
  ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8 \
  verify-blob --bundle /release/SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/416rehman/Vectory/.github/workflows/release.yml@refs/tags/v$version" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com /release/SHA256SUMS >/dev/null || fail 'Release signature verification failed. Nothing was installed.'
checksums=()
while read -r digest name extra; do
  if [[ "$name" == "$archive" ]]; then
    [[ "$digest" =~ ^[a-f0-9]{64}$ && -z "${extra:-}" ]] || fail 'Malformed signed kit checksum.'
    checksums+=("$digest")
  fi
done < "$temporary/SHA256SUMS"
[[ ${#checksums[@]} == 1 ]] || fail 'The signed inventory must contain exactly one server kit.'
printf '%s  %s\n' "${checksums[0]}" "$temporary/$archive" | sha256sum --check --strict >/dev/null || fail 'Server kit checksum failed. Nothing was installed.'
# Extract only the fixed kit file inventory, with no links, permissions or
# owners taken from an archive. The signed candidate gate also validates it.
expected=(.env.example Caddyfile Caddyfile.auto LICENSE NOTICE README.md SHA256SUMS VERSION compose.auto.yaml compose.yaml prepare-offline.sh release-images.sh start-auto.sh start.sh verify-release.sh)
printf '%s\n' "${expected[@]/#/$kit/}" | LC_ALL=C sort > "$temporary/expected"
tar -tzf "$temporary/$archive" | LC_ALL=C sort > "$temporary/members"
cmp -s "$temporary/expected" "$temporary/members" || fail 'The verified server kit has an unexpected file inventory.'
[[ -z "$(tar -tvzf "$temporary/$archive" | awk 'substr($0,1,1)!="-"')" ]] || fail 'The kit must contain regular files only.'
mkdir -p -- "$target"
tar -xzf "$temporary/$archive" --no-same-owner --no-same-permissions --strip-components=1 -C "$target"
chmod 0755 -- "$target/start.sh" "$target/prepare-offline.sh"
mkdir -m 0700 -- "$target/.cache"
cp -- "$temporary/SHA256SUMS" "$temporary/SHA256SUMS.sigstore.json" "$temporary/IMAGE-DIGESTS.env" "$target/.cache/"
if [[ -n "${1:-}" ]]; then export VECTORY_HOSTNAME="$1"; fi
printf 'Installed the verified kit in %s\n' "$target"
"$target/start.sh"
