#!/usr/bin/env bash
# Called only by the verified server-kit start.sh, after release verification.
start_auto() {
  hostname="${VECTORY_HOSTNAME:-}"
  bind="${VECTORY_BIND_IP:-0.0.0.0}"
  if [[ -f "$envfile" && ! -L "$envfile" ]]; then
    hostname="$(sed -n 's/^VECTORY_HOSTNAME=//p' "$envfile")"
    bind="$(sed -n 's/^VECTORY_BIND_IP=//p' "$envfile")"
  elif [[ -z "$hostname" ]]; then
    read -r -p 'DNS name pointing to this server (for example vectory.example.com): ' hostname
  fi
  [[ "$hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ && "$hostname" == *.* && "$hostname" != *..* && ! "$hostname" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Enter a public DNS name without https://, a port or a path. Private/internal servers can use the custom certificate option.'
  check_bind
  [[ ! -L "$envfile" && ( ! -e "$envfile" || -f "$envfile" ) ]] || fail 'The server environment file must be regular.'
  docker volume create --label io.vectory.server=true "${project}_secrets" >/dev/null
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
  # The issuer and leaf are retained across retries. Renewal does not replace
  # either CA or leaf key, and the server hot-reloads validated certificate bytes.
  docker run "${common[@]}" --entrypoint /app/operations/vectory-server-pki "$server_image" --out /var/lib/vectory --hostname "$hostname"
  for volume in caddy_data caddy_config; do
    docker volume create --label io.vectory.server=true "${project}_$volume" >/dev/null
    # Seed an owned, nonempty volume before Caddy mounts it. Otherwise Docker
    # can copy the proxy image's root-owned storage into a still-empty volume,
    # replacing this ownership and breaking the next unprivileged restart.
    docker run --rm --network none --user 10001:10001 --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --mount "type=volume,src=${project}_$volume,dst=/var/lib/vectory" \
      --entrypoint /bin/sh "$server_image" -c '
        set -eu
        umask 077
        test -w /var/lib/vectory
        marker=/var/lib/vectory/.vectory-initialized
        test ! -L "$marker"
        if test ! -e "$marker"; then
          (set -C; printf "Vectory managed proxy storage\n" > "$marker")
        fi
        test -f "$marker"' || fail 'The retained Caddy volume is not writable by its service identity.'
  done
  persist_env automatic
  compose_file="$bundle/compose.auto.yaml"
  chmod 0644 -- "$bundle/Caddyfile.auto"
  if [[ ! -e "$bundle/releases" && ! -L "$bundle/releases" ]]; then mkdir -m 0755 -- "$bundle/releases"; fi
  [[ -d "$bundle/releases" && ! -L "$bundle/releases" ]] || fail 'The local releases mirror must be a regular directory.'
  compose config --quiet
  say "Starting Vectory at https://$hostname. Public DNS must point here and inbound ports 80, 443 and 8443 must be reachable."
  if ! compose up -d --wait --wait-timeout 300; then
    compose logs --no-color --tail 40
    fail 'A service did not become healthy. Check DNS and ports. Retry ./start.sh after correcting them; retained state is preserved.'
  fi
  say "Open https://$hostname"
  status="$(compose exec -T server curl --fail --silent http://127.0.0.1:8080/api/v1/status)"
  if [[ "$status" =~ \"initialized\"[[:space:]]*:[[:space:]]*false ]]; then
    say 'Create your first administrator using this setup secret:'
    compose exec -T server cat /run/secrets/bootstrap
  fi
  say 'Then choose Add device. Its trusted setup flow handles the separate private agent-listener certificate.'
  say "Back up ${project}_data, ${project}_secrets and ${project}_caddy_data. Stop: ./start.sh stop"
}
