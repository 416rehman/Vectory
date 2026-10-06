#!/usr/bin/env bash
# Authenticate prebuilt release bytes before installing the native Linux server.
set -euo pipefail
umask 077
version='0.2.1'
cosign_url='https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64'
cosign_sha256='4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71'
release="https://github.com/416rehman/Vectory/releases/download/v$version"
prefix="vectory-$version-server-native-linux-amd64"
fail() { printf 'Vectory: %s\n' "$*" >&2; exit 1; }
hostname= email= tls_mode=automatic release_dir= cosign_file=
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || fail 'Each option needs its value.'
  case "$1" in
    --hostname) hostname="$2" ;;
    --email) email="$2" ;;
    --tls-mode) tls_mode="$2" ;;
    --release-dir) release_dir="$2" ;;
    --cosign-file) cosign_file="$2" ;;
    *) fail 'Use --hostname DNS, --email ACME-EMAIL or --tls-mode local.' ;;
  esac
  shift 2
done
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || fail 'The native server installer supports Linux x86-64. Use the Docker installer on Windows or macOS.'
[[ "$(id -u)" == 0 ]] || fail 'Run the downloaded installer with sudo bash.'
for tool in curl sha256sum tar stat realpath mktemp awk find wc cmp timeout ps systemctl systemd-analyze; do
  command -v "$tool" >/dev/null || fail "Install $tool, then retry."
done
[[ "$(ps -p 1 -o comm=)" == systemd ]] || fail 'The native server requires a host booted with systemd. Use the Docker installer in another environment.'
systemd_version="$(systemd-analyze --version | awk 'NR==1 {print $2}')"
[[ "$systemd_version" =~ ^[0-9]+$ && "$systemd_version" -ge 252 ]] || fail 'The native server requires systemd 252 or later.'
[[ "$(stat -fc %T /sys/fs/cgroup)" == cgroup2fs ]] || fail 'The native server requires unified cgroup v2.'
[[ "$(realpath -e /var/lib)" == /var/lib && "$(stat -c %u /var/lib)" == 0 ]] || fail 'The staging parent must be a real root-owned /var/lib directory.'
mode="$(stat -c %a /var/lib)"
(( (8#$mode & 8#22) == 0 )) || fail 'The staging parent is writable by another account.'
if [[ -z "$hostname" ]]; then
  [[ -r /dev/tty ]] || fail 'Pass --hostname with the DNS name of this server.'
  read -r -p 'Server DNS name: ' hostname </dev/tty
fi
if [[ -z "$email" && "$tls_mode" == automatic && -r /dev/tty ]]; then
  read -r -p 'Email for HTTPS certificate notices (optional): ' email </dev/tty
fi
[[ "$hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ && "$hostname" != *..* ]] || fail 'Provide a DNS hostname, without a URL or port.'
case "$tls_mode" in automatic|local) ;; *) fail '--tls-mode must be automatic or local.' ;; esac
work="$(mktemp -d /var/lib/.vectory-native-download.XXXXXX)"
[[ "$(realpath -e "$work")" == "$work" && "$(stat -c %u:%a "$work")" == 0:700 ]] || fail 'Could not create private root-owned staging.'
cleanup() {
  [[ "$work" == /var/lib/.vectory-native-download.* && "$(realpath -e "$work")" == "$work" ]] || return 1
  rm -rf -- "$work"
}
trap cleanup EXIT
mkdir "$work/release" "$work/cosign-home" "$work/payload"
download() {
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 1800 --max-filesize "$3" "$1" -o "$2"
}
if [[ -n "$cosign_file" ]]; then
  [[ -f "$cosign_file" && ! -L "$cosign_file" && "$(realpath -e "$cosign_file")" == "$cosign_file" ]] || fail 'The supplied verifier must be a regular absolute file.'
  cp -- "$cosign_file" "$work/cosign"
else
  printf '%s\n' 'Downloading the independently pinned signature verifier.'
  download "$cosign_url" "$work/cosign" 268435456 || fail 'Could not download the signature verifier.'
fi
printf '%s  %s\n' "$cosign_sha256" "$work/cosign" | sha256sum --check --strict >/dev/null || fail 'The signature verifier differs from its independently pinned official release.'
chmod 0700 "$work/cosign"
for name in SHA256SUMS SHA256SUMS.sigstore.json; do
  if [[ -n "$release_dir" ]]; then
    [[ -f "$release_dir/$name" && ! -L "$release_dir/$name" ]] || fail 'The release proof folder is incomplete.'
    [[ "$(stat -c %s "$release_dir/$name")" -le 8388608 ]] || fail 'The release proof is oversized.'
    cp -- "$release_dir/$name" "$work/release/$name"
  else download "$release/$name" "$work/release/$name" 8388608 || fail 'Could not download release authentication.'; fi
done
printf '%s\n' 'Authenticating the exact tagged release identity.'
timeout 180 env -i HOME="$work/cosign-home" PATH=/usr/bin:/bin "$work/cosign" verify-blob \
  --bundle "$work/release/SHA256SUMS.sigstore.json" \
  --certificate-identity "https://github.com/416rehman/Vectory/.github/workflows/release.yml@refs/tags/v$version" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$work/release/SHA256SUMS" >/dev/null || fail 'Release signature verification failed. Nothing was installed.'
mapfile -t inventory < <(awk -v name="$prefix.tar.gz" '$2==name {print}' "$work/release/SHA256SUMS")
[[ ${#inventory[@]} == 1 && "${inventory[0]}" =~ ^[a-f0-9]{64}[[:space:]]+[A-Za-z0-9.-]+$ ]] || fail 'The signed inventory must identify the native kit exactly once.'
if [[ -n "$release_dir" ]]; then
  [[ -f "$release_dir/$prefix.tar.gz" && ! -L "$release_dir/$prefix.tar.gz" ]] || fail 'The release folder has no regular native kit.'
  [[ "$(stat -c %s "$release_dir/$prefix.tar.gz")" -le 2147483648 ]] || fail 'The native kit is oversized.'
  cp -- "$release_dir/$prefix.tar.gz" "$work/release/$prefix.tar.gz"
else download "$release/$prefix.tar.gz" "$work/release/$prefix.tar.gz" 2147483648 || fail 'Could not download the native kit.'; fi
(cd -- "$work/release" && printf '%s\n' "${inventory[0]}" | sha256sum --check --strict >/dev/null) || fail 'The native kit differs from its authenticated checksum.'
# Verify safe member types and names before extraction. The signed native
# archive contains only regular 0644/0755 files under its exact version prefix.
tar -tzf "$work/release/$prefix.tar.gz" > "$work/names"
tar -tvzf "$work/release/$prefix.tar.gz" --numeric-owner > "$work/types"
[[ "$(wc -l < "$work/names")" -le 20002 ]] || fail 'The native kit has too many members.'
declare -A seen=()
while IFS= read -r name; do
  [[ "$name" == "$prefix/"* && "$name" =~ ^[A-Za-z0-9._+@/-]+$ && "$name" != *'//'* && "$name" != */ ]] || fail 'The authenticated native kit has an unsafe path.'
  IFS=/ read -r -a components <<< "$name"
  for component in "${components[@]}"; do [[ "$component" != . && "$component" != .. ]] || fail 'The native kit contains path traversal.'; done
  [[ -z "${seen[$name]:-}" ]] || fail 'The native kit repeats an archive member.'
  seen[$name]=1
done < "$work/names"
awk '$1!="-rw-r--r--" && $1!="-rwxr-xr-x" {exit 1}' "$work/types" || fail 'The native kit has a link, special file or unsafe mode.'
tar -xzf "$work/release/$prefix.tar.gz" --no-same-owner --same-permissions -C "$work/payload"
kit="$work/payload/$prefix"
[[ -f "$kit/start.sh" && ! -L "$kit/start.sh" && -f "$kit/VERSION" && "$(cat "$kit/VERSION")" == "$version" ]] || fail 'The native kit does not describe this stable release.'
printf '%s\n' 'Installing the verified prebuilt server and isolated validator.'
"$kit/start.sh" start --hostname "$hostname" --email "$email" --tls-mode "$tls_mode" --release-dir "$work/release"
for name in SHA256SUMS SHA256SUMS.sigstore.json "$prefix.tar.gz"; do
  cmp -- "$work/release/$name" "/etc/vectory-server/release/$name" >/dev/null || fail 'The installed server did not retain its original authenticated release proof.'
done
printf 'Manage this instance with sudo /opt/vectory-server/%s/start.sh status or stop.\n' "$version"
