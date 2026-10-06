# Prebuilt Linux server

This kit runs the Vectory server on Linux x86-64 without Docker or a compiler.
It includes the server, dashboard, agents, HTTPS proxy, certificate helpers,
and a separate validator with its own pinned Vector. That Vector belongs only
to the server's validator; the kit never installs Vector on agent hosts.

Use a host running systemd 252 or later with unified cgroup v2. The validator
requires filesystem and network namespaces. Setup stops when the host cannot
provide them. Keep ports 80, 443 and 8443 available and point your DNS name at
the host. Normal setup obtains browser HTTPS automatically and retains a
separate private issuer for the outbound agent listener.

After authenticating and extracting the release, retain the signed release
inventory, its Sigstore bundle and the original native archive in one folder:

```sh
sudo ./start.sh start --hostname vectory.example.com --email admin@example.com \
  --release-dir /absolute/path/to/verified-release
```

Setup verifies the release signature and native archive before installing
anything. It installs this version under `/opt/vectory-server`, keeps state
under `/var/lib/vectory-server`, and registers four services. The validator has
a separate read-only root containing only its executable, private Vector and
their runtime libraries. Its fresh temporary filesystem is bounded, its only
socket directory is `/run/vectory-validator`, and it has no external network.
The server connects through that directory's protected Unix socket.

Run `sudo ./start.sh status` to check the services and `sudo ./start.sh stop` to
stop them. State and certificate identities remain on disk. Until the first
administrator exists, successful startup prints the setup secret. Startup
also prints the installed kit's absolute `setup-secret` command, which reads
that same value when requested explicitly. Keep secret-bearing output private.

For [offline maintenance](https://github.com/416rehman/Vectory/blob/main/docs/user/vectory-admin.md),
stop the server, then use `sudo ./admin.sh` with the documented command and
options. The wrapper selects the retained data directory, runs as the server's
account, and uses the kit's own runtime libraries. It refuses maintenance while
the server service is running; the administrator tool also holds the exclusive
data-directory lock. Restart with `sudo ./start.sh start` afterwards.

For a local evaluation, pass `--tls-mode local --hostname localhost`. Caddy
creates a private browser issuer; setup never adds it to a host trust store.
The browser CA is in the retained Caddy data directory, and the separate agent
CA is in `secrets/issuer/agent-ca.pem`. Review and distribute trust explicitly.

The unsigned candidate option is reserved for controlled release tests and
requires both `--candidate-root` and `VECTORY_NATIVE_CI_CANDIDATE=true`. It is
never a fallback when production signature verification fails.
