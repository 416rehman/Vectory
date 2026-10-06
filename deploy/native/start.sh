#!/usr/bin/env bash
# Install and run the authenticated prebuilt Linux server. No compilation.
set -euo pipefail
umask 077
bundle="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fail() { printf 'Vectory: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
usage() {
  say 'Usage: sudo ./start.sh start --hostname DNS [--email ACME-EMAIL] [--tls-mode automatic|local] --release-dir DIR'
  say '       sudo ./start.sh [stop|status|setup-secret]'
  say 'Controlled CI only: start --candidate-root DIR with VECTORY_NATIVE_CI_CANDIDATE=true'
}
action="${1:-start}"
if [[ $# -gt 0 ]]; then shift; fi
case "$action" in start|stop|status|setup-secret) ;; help|--help|-h) usage; exit 0 ;; *) usage; exit 2 ;; esac
hostname= email= release_dir= candidate_root= tls_mode=automatic
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || fail "An option needs its value."
  case "$1" in
    --hostname) hostname="$2" ;;
    --email) email="$2" ;;
    --release-dir) release_dir="$2" ;;
    --candidate-root) candidate_root="$2" ;;
    --tls-mode) tls_mode="$2" ;;
    *) usage; exit 2 ;;
  esac
  shift 2
done
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || fail 'This native server kit supports Linux x86-64.'
[[ "$(id -u)" == 0 ]] || fail 'Run this command with sudo.'
for tool in systemctl systemd-analyze sha256sum tar realpath stat getent install curl cmp awk sed find ps cut readlink groupadd useradd wc; do
  command -v "$tool" >/dev/null || fail "Install $tool, then retry."
done
[[ "$(ps -p 1 -o comm=)" == systemd ]] || fail 'The host must boot with systemd; no container or unsupervised fallback is available.'
systemd_version="$(systemd-analyze --version | awk 'NR==1 {print $2}')"
[[ "$systemd_version" =~ ^[0-9]+$ && "$systemd_version" -ge 252 ]] || fail 'systemd 252 or later is required.'
[[ "$(stat -fc %T /sys/fs/cgroup)" == cgroup2fs ]] || fail 'Unified cgroup v2 is required for the validator resource limits.'
controllers="$(cat /sys/fs/cgroup/cgroup.controllers)"
for controller in memory cpu pids; do
  [[ " $controllers " == *" $controller "* ]] || fail "The host lacks the $controller cgroup controller."
done
config=/etc/vectory-server
state=/var/lib/vectory-server
record=$config/instance.conf
units=(vectory-native-validator vectory-native-certificates vectory-native-server vectory-native-proxy)

root_directory() {
  local path="$1" part
  [[ -d "$path" && ! -L "$path" && "$(realpath -e "$path")" == "$path" ]] || fail 'An installation directory is missing or linked.'
  while :; do
    [[ "$(stat -c %u "$path")" == 0 ]] || fail 'Installation directories must belong to root.'
    part="$(stat -c %a "$path")"
    (( (8#$part & 8#22) == 0 )) || fail 'Installation directories must not be writable by another account.'
    [[ "$path" == / ]] && break
    path="$(dirname -- "$path")"
  done
}
regular() { [[ -f "$1" && ! -L "$1" && "$(realpath -e "$1")" == "$1" ]] || fail 'A required file is missing or linked.'; }
load_record() {
  root_directory "$config"
  regular "$record"
  [[ "$(stat -c %u:%a "$record")" == 0:600 ]] || fail 'The instance record must be a private root-owned file.'
  local key value count=0
  declare -A seen=()
  while IFS='=' read -r key value; do
    [[ -z "${seen[$key]:-}" && -n "$value" ]] || fail 'The retained instance record is malformed.'
    seen[$key]=1
    case "$key" in HOSTNAME) stored_hostname="$value" ;; TLS_MODE) stored_mode="$value" ;; KIT_ROOT) kit="$value" ;; PROOF) proof="$value" ;; *) fail 'Unexpected retained instance setting.' ;; esac
    count=$((count + 1))
  done < "$record"
  [[ "$count" == 4 && "$kit" =~ ^/opt/vectory-server/[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail 'The retained instance record is incomplete.'
  [[ "$proof" == signed || ( "$proof" == candidate && "${VECTORY_NATIVE_CI_CANDIDATE:-false}" == true ) ]] || fail 'An unsigned candidate can run only in an explicitly controlled CI test.'
  root_directory "$kit"
}
socket_check() {
  [[ -d /run/vectory-validator && ! -L /run/vectory-validator ]] || fail 'The private validator runtime directory is missing or linked.'
  [[ "$(stat -c %u:%g:%a /run/vectory-validator)" == "$(id -u vectory-validator):$(id -g vectory-validator):750" ]] || fail 'Unsafe validator directory ownership or mode.'
  [[ -S /run/vectory-validator/validator.sock && ! -L /run/vectory-validator/validator.sock ]] || fail 'The validator did not create its Unix socket.'
  [[ "$(stat -c %u:%g:%a /run/vectory-validator/validator.sock)" == "$(id -u vectory-validator):$(id -g vectory-validator):660" ]] || fail 'Unsafe validator socket ownership or mode.'
}
isolation_check() {
  local pid property actual group quota period
  for property in PrivateNetwork=yes PrivateDevices=yes NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes; do
    actual="$(systemctl show vectory-native-validator.service --property "${property%%=*}" --value)"
    [[ "$actual" == "${property#*=}" ]] || fail "Validator isolation is missing: ${property%%=*}."
  done
  [[ "$(systemctl show vectory-native-validator.service --property RootDirectory --value)" == "$kit/validator-root" ]] || fail 'The validator is not confined to its private root.'
  [[ "$(systemctl show vectory-native-validator.service --property RestrictAddressFamilies --value)" == AF_UNIX ]] || fail 'The validator may create a network socket.'
  [[ -z "$(systemctl show vectory-native-validator.service --property CapabilityBoundingSet --value)" ]] || fail 'The validator retained a capability.'
  actual="$(systemctl show vectory-native-validator.service --property BindPaths --value)"
  [[ "$actual" == /run/vectory-validator:/run/vectory-validator || "$actual" == /run/vectory-validator:/run/vectory-validator:rbind ]] || fail 'The validator has an unexpected host bind mount.'
  [[ -z "$(systemctl show vectory-native-validator.service --property BindReadOnlyPaths --value)" ]] || fail 'The validator has an unexpected read-only host bind mount.'
  [[ "$(systemctl show vectory-native-validator.service --property MemorySwapMax --value)" == 0 ]] || fail 'The validator swap limit is missing.'
  [[ "$(systemctl show vectory-native-validator.service --property CPUQuotaPerSecUSec --value)" == 1s ]] || fail 'The validator CPU limit is missing.'
  [[ "$(systemctl show vectory-native-validator.service --property KillMode --value)" == control-group ]] || fail 'Stopping the validator would leave child processes behind.'
  [[ "$(systemctl show vectory-native-validator.service --property TasksMax --value)" == 64 ]] || fail 'The validator process limit is missing.'
  [[ "$(systemctl show vectory-native-validator.service --property MemoryMax --value)" == 536870912 ]] || fail 'The validator memory limit is missing.'
  pid="$(systemctl show vectory-native-validator.service --property MainPID --value)"
  group="$(systemctl show vectory-native-validator.service --property ControlGroup --value)"
  [[ "$group" =~ ^/[A-Za-z0-9._/-]+$ && "$group" != *..* ]] || fail 'The validator has no valid resource control group.'
  [[ "$(cat "/sys/fs/cgroup$group/memory.max")" == 536870912 && "$(cat "/sys/fs/cgroup$group/memory.swap.max")" == 0 && "$(cat "/sys/fs/cgroup$group/pids.max")" == 64 ]] || fail 'The kernel did not apply the validator memory, swap or process limit.'
  read -r quota period < "/sys/fs/cgroup$group/cpu.max"
  [[ "$quota" =~ ^[1-9][0-9]*$ && "$period" =~ ^[1-9][0-9]*$ ]] && (( quota <= period )) || fail 'The kernel did not apply the validator CPU limit.'
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$(readlink "/proc/$pid/root")" == "$kit/validator-root" ]] || fail 'The running validator has the wrong filesystem root.'
  [[ "$(cat "/proc/$pid/cgroup")" == "0::$group" ]] || fail 'The running validator is outside its resource control group.'
  actual="$(awk '$1=="Uid:" {print $2":"$3":"$4":"$5}' "/proc/$pid/status")"
  [[ "$actual" == "$(id -u vectory-validator):$(id -u vectory-validator):$(id -u vectory-validator):$(id -u vectory-validator)" ]] || fail 'The running validator has the wrong user identity.'
  [[ "$(awk '$1=="NoNewPrivs:" {print $2}' "/proc/$pid/status")" == 1 && "$(awk '$1=="Seccomp:" {print $2}' "/proc/$pid/status")" == 2 ]] || fail 'The kernel did not apply the validator privilege and syscall restrictions.'
  [[ -z "$(awk '$1 ~ /^Cap(Inh|Prm|Eff|Bnd|Amb):$/ && $2 != "0000000000000000" {print "capability"}' "/proc/$pid/status")" ]] || fail 'The running validator has a capability.'
  [[ "$(readlink "/proc/$pid/ns/net")" != "$(readlink /proc/self/ns/net)" ]] || fail 'The running validator shares the host network.'
  [[ ! -e "/proc/$pid/root$state" && ! -e "/proc/$pid/root/etc/vectory-server" ]] || fail 'Production files are visible to the validator.'
  socket_check
}
worker_health() {
  local reply
  systemctl is-active --quiet vectory-native-validator.service || return 1
  reply="$(curl --noproxy '*' --fail --silent --max-time 3 --unix-socket /run/vectory-validator/validator.sock http://validator/health)" || return 1
  [[ "$reply" == *'"status":"ok"'* && "$reply" == *'"vector_version":"0.58.0"'* && "$reply" == *'"worker_protocol":2'* ]]
}
browser_status() {
  local -a trust=()
  if [[ "$tls_mode" == local ]]; then
    [[ -f "$state/caddy-data/caddy/pki/authorities/local/root.crt" && ! -L "$state/caddy-data/caddy/pki/authorities/local/root.crt" ]] || return 1
    trust=(--cacert "$state/caddy-data/caddy/pki/authorities/local/root.crt")
  fi
  curl --noproxy '*' --fail --silent --max-time 3 --max-filesize 65536 --proto '=https' --resolve "$hostname:443:127.0.0.1" "${trust[@]}" "https://$hostname/api/v1/status"
}
health() {
  local unit
  for unit in "${units[@]}"; do systemctl is-active --quiet "$unit.service" || return 1; done
  worker_health || return 1
  curl --noproxy '*' --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/api/v1/status >/dev/null || return 1
  browser_status >/dev/null || return 1
}
if [[ "$action" != start ]]; then
  load_record
  hostname="$stored_hostname" tls_mode="$stored_mode"
  case "$action" in
    stop) systemctl stop vectory-native-proxy vectory-native-server vectory-native-certificates vectory-native-validator; say 'Server stopped; state and certificate identities are retained.' ;;
    status) health || fail 'At least one service is not ready. Inspect its journal before restarting.'; isolation_check; say 'All four services are running; the validator is isolated and responds through its protected socket.' ;;
    setup-secret) regular "$state/secrets/bootstrap"; cat -- "$state/secrets/bootstrap" ;;
  esac
  exit 0
fi
if [[ -e "$record" ]]; then
  load_record
  [[ -z "$hostname" || "$hostname" == "$stored_hostname" ]] || fail 'This instance already has another hostname; retain its original identity.'
  hostname="$stored_hostname" tls_mode="$stored_mode"
  if [[ -z "$email" ]]; then
    regular "$config/Caddyfile"
    email="$(awk '$1=="email" {print $2}' "$config/Caddyfile")"
  fi
  if [[ "$proof" == signed && -z "$release_dir" && -z "$candidate_root" ]]; then release_dir="$config/release"; fi
fi
[[ "$hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ && "$hostname" != *..* ]] || fail 'Provide the DNS hostname with --hostname.'
case "$tls_mode" in automatic|local) ;; *) fail '--tls-mode must be automatic or local.' ;; esac
[[ -z "$email" || "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || fail 'Provide a valid ACME email address.'
[[ -f "$bundle/VERSION" && ! -L "$bundle/VERSION" ]] || fail 'The native kit has no regular VERSION file.'
version="$(cat "$bundle/VERSION")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail 'The kit version is invalid.'
prefix="vectory-$version-server-native-linux-amd64"
target="/opt/vectory-server/$version"
[[ ! -e "$record" || "$kit" == "$target" ]] || fail 'This host retains another native version; review a server upgrade before replacing its services.'
root_directory /var/lib
work="$(mktemp -d /var/lib/.vectory-native-install.XXXXXX)"
public_started=
finish_install() {
  local result=$1
  trap - EXIT
  if [[ "$result" != 0 && -n "$public_started" ]]; then
    systemctl stop vectory-native-proxy vectory-native-server vectory-native-certificates vectory-native-validator || say 'Could not stop every native service; inspect them before retrying.'
  fi
  rm -rf -- "$work"
  exit "$result"
}
trap 'finish_install "$?"' EXIT
verify_inventory() {
  local directory="$1" digest name extra count=0
  regular "$directory/SHA256SUMS"
  declare -A seen=()
  while read -r digest name extra; do
    [[ "$digest" =~ ^[a-f0-9]{64}$ && -z "${extra:-}" && "$name" =~ ^[A-Za-z0-9_.+@/-]+$ && "$name" != /* && "$name" != *..* ]] || fail 'Malformed native kit inventory.'
    regular "$directory/$name"
    [[ -z "${seen[$name]:-}" ]] || fail 'The native kit inventory repeats a file.'
    seen[$name]=1
    count=$((count + 1))
  done < "$directory/SHA256SUMS"
  [[ "$count" -ge 20 ]] || fail 'The native kit is incomplete.'
  [[ "$(find "$directory" -type f | wc -l)" == "$((count + 1))" ]] || fail 'The native kit contains files outside its inventory.'
  [[ -z "$(find "$directory" ! -type f ! -type d -print -quit)" ]] || fail 'The native kit contains a link or special file.'
  (cd -- "$directory" && sha256sum --check --strict SHA256SUMS >/dev/null) || fail 'Native kit contents failed their checksums.'
}
if [[ -n "$candidate_root" ]]; then
  [[ "${VECTORY_NATIVE_CI_CANDIDATE:-false}" == true && -z "$release_dir" && "$(realpath -e "$candidate_root")" == "$bundle" ]] || fail 'Unsigned candidate installation requires its exact root and explicit controlled CI consent.'
  proof=candidate
  say 'UNSIGNED RELEASE CANDIDATE: controlled test only; no production signature verification is claimed.'
  verify_inventory "$bundle"
  cp -a -- "$bundle/." "$work/payload"
  verify_inventory "$work/payload"
else
  [[ -n "$release_dir" ]] || fail 'Pass --release-dir with the signed inventory, Sigstore bundle and original native archive.'
  release_dir="$(realpath -e "$release_dir")"
  for file in SHA256SUMS SHA256SUMS.sigstore.json "$prefix.tar.gz"; do regular "$release_dir/$file"; cp -- "$release_dir/$file" "$work/$file"; done
  regular "$bundle/bin/cosign"
  cp -- "$bundle/bin/cosign" "$work/cosign"
  [[ "$(sha256sum "$work/cosign" | cut -d ' ' -f 1)" == 4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 ]] || fail 'The native Sigstore verifier differs from its independently pinned official release.'
  chmod 0700 "$work/cosign"
  "$work/cosign" verify-blob --bundle "$work/SHA256SUMS.sigstore.json" --certificate-identity "https://github.com/416rehman/Vectory/.github/workflows/release.yml@refs/tags/v$version" --certificate-oidc-issuer https://token.actions.githubusercontent.com "$work/SHA256SUMS" >/dev/null || fail 'Native release signature verification failed.'
  mapfile -t checksums < <(awk -v name="$prefix.tar.gz" '$2==name {print}' "$work/SHA256SUMS")
  [[ ${#checksums[@]} == 1 && "${checksums[0]}" =~ ^[a-f0-9]{64}[[:space:]]+[A-Za-z0-9.-]+$ ]] || fail 'The signed release must identify the native archive exactly once.'
  (cd -- "$work" && printf '%s\n' "${checksums[0]}" | sha256sum --check --strict >/dev/null) || fail 'The native archive differs from its signed checksum.'
  declare -A members=()
  while IFS= read -r member; do
    [[ "$member" == "$prefix/"* && "$member" =~ ^[A-Za-z0-9_.+@/-]+$ && "$member" != *..* && -z "${members[$member]:-}" ]] || fail 'The authenticated native archive contains an unsafe or repeated member.'
    members[$member]=1
  done < <(tar -tzf "$work/$prefix.tar.gz")
  [[ ${#members[@]} -ge 20 && -z "$(tar -tvzf "$work/$prefix.tar.gz" | awk 'substr($0,1,1)!="-" {print "unsafe"; exit}')" ]] || fail 'The native archive must contain only bounded regular payload files.'
  mkdir "$work/payload"
  tar -xzf "$work/$prefix.tar.gz" --strip-components=1 --no-same-owner -C "$work/payload"
  verify_inventory "$work/payload"
  cmp -- "$bundle/deploy/native/start.sh" "$work/payload/deploy/native/start.sh" >/dev/null || fail 'This launcher differs from the authenticated native release.'
  proof=signed
fi
# Every installed byte comes from the private authenticated copy, never from
# a mutable download directory after its verification.
root_directory /opt
if [[ ! -e /opt/vectory-server ]]; then install -d -m 0755 /opt/vectory-server; fi
root_directory /opt/vectory-server
if [[ -e "$target" ]]; then
  root_directory "$target"
  cmp -- "$target/SHA256SUMS" "$work/payload/SHA256SUMS" >/dev/null || fail 'The installed native version differs from this authenticated kit.'
  verify_inventory "$target"
else
  mv -- "$work/payload" "$target"
  chown -R root:root -- "$target"
  find "$target" -type d -exec chmod 0755 '{}' +
  find "$target" -type f -perm /111 -exec chmod 0755 '{}' +
  find "$target" -type f ! -perm /111 -exec chmod 0644 '{}' +
fi
kit="$target"
install -d -m 0755 "$kit/validator-root/tmp" "$kit/validator-root/run" "$kit/validator-root/run/vectory-validator"
for account in vectory-server vectory-validator vectory-proxy; do
  if ! getent group "$account" >/dev/null; then groupadd --system "$account"; fi
  if ! getent passwd "$account" >/dev/null; then useradd --system --gid "$account" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$account"; fi
  [[ "$(id -u "$account")" != 0 && "$(id -gn "$account")" == "$account" ]] || fail 'A native service account has an unsafe primary identity.'
  shell="$(getent passwd "$account" | cut -d: -f7)"
  [[ "$shell" == /usr/sbin/nologin || "$shell" == /sbin/nologin || "$shell" == /bin/false ]] || fail 'Native service accounts must have no login shell.'
done
[[ "$(id -u vectory-server)" != "$(id -u vectory-validator)" && "$(id -u vectory-proxy)" != "$(id -u vectory-validator)" ]] || fail 'The validator must have a separate user.'
root_directory /var/lib
if [[ ! -e "$state" ]]; then install -d -m 0755 "$state"; fi
root_directory "$state"
for item in data secrets caddy-data caddy-config; do
  owner=vectory-server
  [[ "$item" != caddy-* ]] || owner=vectory-proxy
  if [[ -e "$state/$item" ]]; then
    [[ -d "$state/$item" && ! -L "$state/$item" && "$(realpath -e "$state/$item")" == "$state/$item" && "$(stat -c %u:%a "$state/$item")" == "$(id -u "$owner"):700" ]] || fail 'A retained state directory has unsafe ownership or permissions.'
  else install -d -m 0700 -o "$owner" -g "$owner" "$state/$item"; fi
done
if [[ ! -e "$state/secrets/bootstrap" ]]; then
  "$kit/bin/vectory-local-pki" --bootstrap-only --bootstrap "$state/secrets/bootstrap" >/dev/null
  chown vectory-server:vectory-server "$state/secrets/bootstrap"
fi
regular "$state/secrets/bootstrap"
[[ "$(stat -c %u:%a "$state/secrets/bootstrap")" == "$(id -u vectory-server):600" ]] || fail 'The retained bootstrap file is not private.'
root_directory /etc
if [[ ! -e "$config" ]]; then install -d -m 0755 "$config"; fi
root_directory "$config"
if [[ "$proof" == signed ]]; then
  if [[ ! -e "$config/release" ]]; then install -d -m 0700 "$config/release"; fi
  root_directory "$config/release"
  for file in SHA256SUMS SHA256SUMS.sigstore.json "$prefix.tar.gz"; do
    [[ ! -L "$config/release/$file" && ( ! -e "$config/release/$file" || -f "$config/release/$file" ) ]] || fail 'The retained release proof has an unsafe file.'
    install -m 0600 "$work/$file" "$config/release/$file"
  done
fi
for name in server.env certificates.env Caddyfile instance.conf; do [[ ! -L "$config/$name" && ( ! -e "$config/$name" || -f "$config/$name" ) ]] || fail 'A retained configuration file is linked or not regular.'; done
cat > "$work/server.env" <<EOF
VECTORY_DATA_DIR=$state/data
VECTORY_DASHBOARD_DIR=$kit/dashboard
VECTORY_BUNDLED_RELEASES_DIR=$kit/agents
VECTORY_RELEASES_DIR=$state/data/releases
VECTORY_BOOTSTRAP_SECRET_FILE=$state/secrets/bootstrap
VECTORY_TLS_CERT=$state/secrets/server_cert
VECTORY_TLS_KEY=$state/secrets/server_key
VECTORY_VALIDATION_SOCKET=/run/vectory-validator/validator.sock
VECTORY_HTTP_ADDR=127.0.0.1:8080
VECTORY_AGENT_ADDR=0.0.0.0:8443
VECTORY_PUBLIC_URL=https://$hostname
VECTORY_PUBLIC_AGENT_URL=https://$hostname:8443
VECTORY_COOKIE_SECURE=true
VECTORY_TRUST_PROXY_HEADERS=true
VECTORY_HTTP_ALLOWED_PEERS=127.0.0.1,::1
EOF
printf 'VECTORY_HOSTNAME=%s\n' "$hostname" > "$work/certificates.env"
{
  printf '{\n  admin off\n'
  [[ -z "$email" ]] || printf '  email %s\n' "$email"
  printf '}\n%s {\n' "$hostname"
  [[ "$tls_mode" != local ]] || printf '  tls internal\n'
  printf '  reverse_proxy 127.0.0.1:8080\n}\n'
} > "$work/Caddyfile"
printf 'HOSTNAME=%s\nTLS_MODE=%s\nKIT_ROOT=%s\nPROOF=%s\n' "$hostname" "$tls_mode" "$kit" "$proof" > "$work/instance.conf"
install -m 0640 -o root -g vectory-server "$work/server.env" "$config/server.env"
install -m 0640 -o root -g vectory-server "$work/certificates.env" "$config/certificates.env"
install -m 0644 "$work/Caddyfile" "$config/Caddyfile"
install -m 0600 "$work/instance.conf" "$record"
for unit in "${units[@]}"; do
  regular "$kit/deploy/native/$unit.service"
  [[ ! -L "/etc/systemd/system/$unit.service" ]] || fail 'A native unit path is linked.'
  sed "s|@KIT_ROOT@|$kit|g" "$kit/deploy/native/$unit.service" > "$work/$unit.service"
  install -m 0644 "$work/$unit.service" "/etc/systemd/system/$unit.service"
done
systemd-analyze verify "${units[@]/%/.service}" || fail 'The host refused the native service definitions.'
systemctl daemon-reload
systemctl enable "${units[@]/%/.service}" >/dev/null
# Public services remain stopped until the worker's actual namespaces and
# kernel resource limits have been checked, including on an explicit retry.
public_started=1
systemctl stop vectory-native-proxy vectory-native-server vectory-native-certificates
systemctl start vectory-native-validator
ready=
for attempt in {1..30}; do if worker_health; then ready=true; break; fi; sleep 1; done
[[ "$ready" == true ]] || fail 'The isolated validator did not become ready. No public service was started.'
isolation_check
systemctl start vectory-native-certificates vectory-native-server vectory-native-proxy
ready=
for attempt in {1..60}; do if health; then ready=true; break; fi; sleep 1; done
[[ "$ready" == true ]] || fail 'The services did not become ready; inspect their journals. State is retained for an explicit retry.'
isolation_check
status="$(browser_status)" || fail 'Could not read the local server initialization state over verified HTTPS.'
[[ "$status" =~ \"initialized\"[[:space:]]*:[[:space:]]*(true|false) ]] || fail 'The local server returned no initialization state.'
initialized="${BASH_REMATCH[1]}"
if [[ "$initialized" == false ]]; then
  regular "$state/secrets/bootstrap"
  [[ "$(stat -c %u:%a "$state/secrets/bootstrap")" == "$(id -u vectory-server):600" ]] || fail 'The retained bootstrap file is not private.'
fi
say "Vectory is serving its API at https://$hostname; verify browser certificate trust before creating the first administrator."
if [[ "$initialized" == false ]]; then
  say 'Create your first administrator using this setup secret:'
  cat -- "$state/secrets/bootstrap"
  printf '\n'
fi
say "Use sudo $kit/start.sh setup-secret to read the first-administrator secret."
public_started=
