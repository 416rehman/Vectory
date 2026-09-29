"""Disposable native server upgrade with real TLS/agent/Vector evidence.

Requires Python cryptography/psutil from the native security harness. Never reads
preview state. Secrets live only in the temporary fixture and are not reported.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "tests/security/attempt-native.py"
spec = importlib.util.spec_from_file_location("native_fixture", HELPER)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def totp(secret, step):
    key = base64.b32decode(secret + "=" * ((8 - len(secret) % 8) % 8))
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((int.from_bytes(digest[offset:offset + 4], "big") & 0x7fffffff) % 1000000).zfill(6)


def database_snapshot(path):
    # Only our stopped fixture database is read. Sensitive rows remain memory-
    # only; the report contains counts and hashes of whole table snapshots.
    with sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True) as db:
        names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        tables = {}
        for name in names:
            rows = sorted([list(r) for r in db.execute('SELECT * FROM "' + name.replace('"', '""') + '"')], key=repr)
            encoded = json.dumps(rows, sort_keys=True, separators=(",", ":"), default=lambda x: x.hex()).encode()
            tables[name] = {"count": len(rows), "sha256": hashlib.sha256(encoded).hexdigest()}
        migrations = [r[0] for r in db.execute("SELECT version FROM _sqlx_migrations ORDER BY version")]
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_key_errors = list(db.execute("PRAGMA foreign_key_check"))
    return {"tables": tables, "migrations": migrations, "integrity": integrity, "foreign_key_errors": len(foreign_key_errors)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-server", type=Path, required=True)
    parser.add_argument("--server", type=Path, required=True)
    parser.add_argument("--agent", type=Path, default=ROOT / "agent/vectory.exe")
    parser.add_argument("--vector", type=Path, default=ROOT / ".local/tools/vector-0.58.0/bin/vector.exe")
    parser.add_argument("--dashboard", type=Path, default=ROOT / "dashboard/dist")
    parser.add_argument("--releases", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output = args.output.resolve()
    report = {"recorded_at": native.utc(), "passed": False, "scope": "Fresh disposable Windows native old-server database upgraded to staged current server. Real enrolled Go agent and pinned Vector activation over mTLS. No preview credentials, state, processes or OS service installations accessed.", "checks": [], "binary_sha256": {k: native.sha(getattr(args, k)) for k in ["old_server", "server", "agent", "vector"]}}
    temp = Path(tempfile.mkdtemp(prefix="vectory-upgrade-proof-")).resolve()
    server = agent = None
    logs = []
    try:
        for name in ["old_server", "server", "agent"]:
            source = getattr(args, name).resolve()
            copy = temp / (name + source.suffix)
            shutil.copyfile(source, copy)
            setattr(args, name, copy)
        native.pki(temp)
        http_port, tls_port = native.free_port(), native.free_port()
        origin, tls_origin = f"http://127.0.0.1:{http_port}", f"https://127.0.0.1:{tls_port}"
        state = temp / "server-state"
        bootstrap, admin_password, operator_password = [os.urandom(32).hex() for _ in range(3)]
        (temp / "bootstrap").write_text(bootstrap)
        base_env = {k: v for k, v in os.environ.items() if not k.upper().startswith("VECTORY_") and k.upper() not in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]}
        env = base_env.copy()
        env.update(VECTORY_DATA_DIR=str(state), VECTORY_HTTP_ADDR=f"127.0.0.1:{http_port}", VECTORY_AGENT_ADDR=f"127.0.0.1:{tls_port}", VECTORY_TLS_CERT=str(temp / "server.pem"), VECTORY_TLS_KEY=str(temp / "server-key.pem"), VECTORY_BOOTSTRAP_SECRET_FILE=str(temp / "bootstrap"), VECTORY_DEVELOPMENT="true", VECTORY_COOKIE_SECURE="false", VECTORY_DASHBOARD_DIR=str(args.dashboard.resolve()), VECTORY_RELEASES_DIR=str(args.releases.resolve()), NO_COLOR="1")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

        def start(binary, label):
            log = (temp / f"{label}.log").open("wb")
            logs.append(log)
            return subprocess.Popen([str(binary)], cwd=temp, env=env, stdout=log, stderr=log, creationflags=flags)

        def client():
            return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

        admin, operator, public = client(), client(), client()
        csrf = op_csrf = ""

        def request(path, body=None, method=None, opener=None, token=None, expected=200):
            opener = opener or admin
            token = csrf if token is None else token
            req = urllib.request.Request(origin + path, data=None if body is None else json.dumps(body).encode(), method=method or ("GET" if body is None else "POST"), headers={"Content-Type": "application/json", "X-CSRF-Token": token})
            try:
                response = opener.open(req, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status, headers, data = response.status, dict(response.headers), response.read()
            if status != expected:
                # Do not echo HTTP bodies: authentication responses may contain
                # synthetic secrets and they are never needed in failure logs.
                raise AssertionError(f"{req.method} {path}: HTTP {status}, expected {expected}")
            return headers, data

        def api(path, body=None, **kwargs):
            return json.loads(request("/api/v1" + path, body, **kwargs)[1])

        def until(name, predicate, timeout=100):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                if server.poll() is not None:
                    raise AssertionError("Disposable server exited during " + name)
                value = predicate()
                if value:
                    print("PASS " + name, flush=True)
                    return value
                time.sleep(.4)
            raise AssertionError(name + " timed out")

        def ready():
            try:
                return api("/status")
            except urllib.error.URLError:
                return False

        server = start(args.old_server, "old-server")
        until("older server initializes isolated state", ready, 20)
        session = api("/bootstrap", {"bootstrap_secret": bootstrap, "name": "Synthetic upgrade admin", "email": "upgrade-admin@example.invalid", "password": admin_password})
        csrf = session["csrf_token"]
        admin_id = session["user"]["id"]
        account = api("/users", {"name": "Synthetic upgrade operator", "email": "upgrade-operator@example.invalid", "password": operator_password, "role": "operator"})
        op_session = api("/login", {"email": account["email"], "password": operator_password}, opener=operator)
        op_csrf = op_session["csrf_token"]
        setup = api("/mfa/setup", {"password": operator_password}, opener=operator, token=op_csrf)
        recovery = api("/mfa/confirm", {"code": totp(setup["secret"], int(time.time()) // 30)}, opener=operator, token=op_csrf)
        assert recovery["enabled"] and len(recovery["recovery_codes"]) == 8
        disabled = api("/users", {"name": "Synthetic disabled account", "email": "upgrade-disabled@example.invalid", "password": os.urandom(24).hex(), "role": "viewer"})
        api("/users/" + disabled["id"], {"name": disabled["name"], "role": "viewer", "enabled": False, "revision": disabled["revision"], "current_password": admin_password}, method="PUT")

        agent_state, config_dir, vector_data = temp / "agent-state", temp / "config", temp / "vector-data"
        config_dir.mkdir()
        vector_data.mkdir()
        managed = config_dir / "managed.json"
        good = {"data_dir": str(vector_data), "sources": {"seed": {"type": "demo_logs", "format": "json", "interval": 1}}, "sinks": {"discard": {"type": "blackhole", "inputs": ["seed"]}}}
        managed.write_text(json.dumps(good))
        policy = temp / "capability-policy.json"
        policy.write_text(json.dumps({"allowed_file_roots": [str(vector_data)]}))

        def cli(*arguments, input=None):
            result = subprocess.run([str(args.agent), *arguments], cwd=temp, env=base_env, input=input, text=True, capture_output=True, timeout=40, creationflags=flags)
            if result.returncode:
                raise AssertionError(f"Isolated agent {arguments[0]} exited {result.returncode}")

        cli("install", "--state-dir", str(agent_state), "--vector-binary", str(args.vector.resolve()), "--managed-config", str(managed), "--capability-policy", str(policy), "--adopt", "--json")
        enrollment = api("/tokens", {"name": "Synthetic upgrade enrollment", "expires_hours": 1, "max_uses": 1})
        cli("enroll", "--state-dir", str(agent_state), "--server", tls_origin, "--ca-file", str(temp / "ca.pem"), "--id", "upgrade-fixture-" + uuid.uuid4().hex[:10], "--token-stdin", "--json", input=enrollment["token"] + "\n")
        device_id = api("/devices")[0]["id"]
        selector = {"device_ids": [device_id], "group_ids": [], "exclude_ids": []}
        rollout = {"kind": "all", "canary_size": 1, "batch_size": 1, "observation_seconds": 1, "failure_threshold": 0}
        api("/deployments", {"policy": {"heartbeat_seconds": 10, "sync_paused": False, "telemetry_enabled": False}, "selector": selector, "priority": 100, "target_mode": "snapshot", "rollout": rollout})
        draft = api("/configurations", {"name": "Synthetic upgrade history", "description": "Disposable native upgrade fixture", "config": good, "graph": {"nodes": [], "edges": []}})
        version1 = api("/configurations/" + draft["id"] + "/publish", {"revision": draft["revision"], "message": "Verified first version"})
        key1, key2, rollback_key = [str(uuid.uuid4()) for _ in range(3)]
        body1 = {"request_id": key1, "version_id": version1["id"], "selector": selector, "expected_device_ids": [device_id], "priority": 100, "target_mode": "snapshot", "rollout": rollout}
        deployment1 = api("/deployments", body1)
        agent_log = (temp / "agent.log").open("wb")
        logs.append(agent_log)

        def start_agent():
            return subprocess.Popen([str(args.agent), "run", "--state-dir", str(agent_state), "--json"], cwd=temp, env=base_env, stdout=agent_log, stderr=agent_log, creationflags=flags)

        def current():
            return api("/devices/" + device_id)

        def verified(version, generation):
            d = current()
            return d if d.get("apply_state") == "verified_applied" and d.get("reported_generation") == generation and d.get("desired_generation") == generation and d.get("actual_sha256") == version["sha256"] else None

        agent = start_agent()
        until("older server receives native version1 verified activation", lambda: verified(version1, 1))
        second = json.loads(json.dumps(good))
        second["transforms"] = {"upgrade": {"type": "remap", "inputs": ["seed"], "source": ".upgrade = true"}}
        second["sinks"]["discard"]["inputs"] = ["upgrade"]
        draft = api("/configurations/" + draft["id"] + "/draft", {"revision": draft["revision"], "config": second, "graph": {"nodes": [], "edges": []}, "message": "Synthetic second revision"}, method="PUT")
        version2 = api("/configurations/" + draft["id"] + "/publish", {"revision": draft["revision"], "message": "Verified second version"})
        body2 = {**body1, "request_id": key2, "version_id": version2["id"], "priority": 200}
        deployment2 = api("/deployments", body2)
        until("older server receives native version2 verified activation", lambda: verified(version2, 2))
        replacement = api("/deployments/" + deployment2["id"] + "/rollback", {"request_id": rollback_key})
        last = until("older keyed rollback restores and verifies version1", lambda: verified(version1, 3))
        until("rollback deployment completes before offline snapshot", lambda: api("/deployments/" + replacement["id"] + "/summary")["status"] == "completed")
        assert native.sha(managed) == version1["sha256"]
        report["checks"].append({"name": "old binary creates real history and verifies deployments plus keyed rollback", "passed": True, "desired_generation": 3, "reported_generation": 3, "version1_sha256": version1["sha256"], "version2_sha256": version2["sha256"], "request_mappings": 3})
        native.stop(agent)
        agent = None
        before_api = {"users": api("/users"), "pipeline": api("/configurations/" + draft["id"]), "revisions": api("/configurations/" + draft["id"] + "/history?kind=revisions"), "versions": api("/configurations/" + draft["id"] + "/history?kind=versions"), "device": current(), "target": api("/deployments/" + replacement["id"] + "/targets")}
        assert before_api["revisions"]["total"] == 2 and before_api["versions"]["total"] == 2
        assert len(before_api["users"]) == 3 and any(u["id"] == disabled["id"] and not u["enabled"] for u in before_api["users"])
        pending = api("/login", {"email": account["email"], "password": operator_password}, opener=client())
        assert pending["mfa_required"] is True
        api("/deployments/requests", expected=404)
        native.stop(server)
        server = None
        before = database_snapshot(state / "vectory.db")
        assert before["migrations"][-1] == 15
        assert before["tables"]["login_challenges"]["count"] == 1
        assert before["tables"]["deployment_requests"]["count"] == 3
        assert before["tables"]["user_mfa"]["count"] == 1 and before["tables"]["mfa_recovery_codes"]["count"] == 8
        assert before["tables"]["credentials"]["count"] == 1
        backup = temp / "offline-backup"
        shutil.copytree(state, backup)
        assert database_snapshot(backup / "vectory.db") == before
        key_hashes = {str(p.relative_to(state / "keys")): native.sha(p) for p in (state / "keys").rglob("*") if p.is_file()}
        report["checks"].append({"name": "stopped disposable state has consistent offline backup", "passed": True, "migrations_before": before["migrations"], "integrity": before["integrity"], "foreign_key_errors": before["foreign_key_errors"], "backup_snapshot_matches": True})

        server = start(args.server, "current-server")
        until("staged current server upgrades existing disposable state", ready, 30)
        after = database_snapshot(state / "vectory.db")
        assert after["migrations"] == before["migrations"] + [16]
        preserved = []
        for name, fingerprint in before["tables"].items():
            if name not in ["_sqlx_migrations", "login_challenges"]:
                assert after["tables"][name] == fingerprint, "Upgrade changed table " + name
                preserved.append(name)
        assert after["tables"]["login_challenges"]["count"] == 0
        assert after["integrity"] == "ok" and after["foreign_key_errors"] == 0
        assert key_hashes == {str(p.relative_to(state / "keys")): native.sha(p) for p in (state / "keys").rglob("*") if p.is_file()}
        assert api("/session")["user"]["id"] == admin_id
        assert api("/session", opener=operator, token=op_csrf)["user"]["id"] == account["id"]
        for label, path in [("users", "/users"), ("pipeline", "/configurations/" + draft["id"]), ("revisions", "/configurations/" + draft["id"] + "/history?kind=revisions"), ("versions", "/configurations/" + draft["id"] + "/history?kind=versions"), ("target", "/deployments/" + replacement["id"] + "/targets")]:
            assert api(path) == before_api[label], "Upgrade changed public " + label
        for key in ["desired_version_id", "desired_generation", "reported_generation", "actual_sha256", "apply_state"]:
            assert current()[key] == before_api["device"][key], "Upgrade changed activation field " + key
        report["checks"].append({"name": "migration preserves accounts security mappings immutable history and activation evidence", "passed": True, "migrations_after": after["migrations"], "unchanged_tables": preserved, "protected_key_bytes_preserved": True, "existing_sessions_work": True, "pending_login_challenges_cleared": True, "integrity": after["integrity"], "foreign_key_errors": 0})

        history = api("/deployments/requests")
        rows = {r["request_id"]: r for r in history["items"]}
        assert history["total"] == 3
        assert rows[key1]["deployment_id"] == deployment1["id"] and rows[key2]["deployment_id"] == deployment2["id"]
        assert rows[rollback_key]["deployment_id"] == replacement["id"] and rows[rollback_key]["source_deployment_id"] == deployment2["id"]
        assert api("/deployments/history")["request_history"] is True
        assert api("/deployments/requests", opener=operator, token=op_csrf)["total"] == 0
        replay_before = database_snapshot(state / "vectory.db")
        assert api("/deployments", body1)["id"] == deployment1["id"]
        assert api("/deployments/" + deployment2["id"] + "/rollback", {"request_id": rollback_key})["id"] == replacement["id"]
        assert database_snapshot(state / "vectory.db") == replay_before
        api("/login/mfa", {"challenge_token": pending["challenge_token"], "recovery_code": recovery["recovery_codes"][0]}, opener=client(), expected=401)
        fresh_operator = client()
        challenge = api("/login", {"email": account["email"], "password": operator_password}, opener=fresh_operator)
        fresh_session = api("/login/mfa", {"challenge_token": challenge["challenge_token"], "totp_code": totp(setup["secret"], int(time.time()) // 30 + 1)}, opener=fresh_operator)
        assert fresh_session["user"]["id"] == account["id"]
        report["checks"].append({"name": "new capability discovers old exact results and replay remains atomic", "passed": True, "discovered_committed_requests": 3, "other_actor_rows": 0, "replays_change_no_state": True, "fresh_mfa_login_preserved": True, "old_challenge_rejected": True})

        # Deliver actual bundled bytes under current HTTP security headers.
        headers, index = request("/", opener=public)
        assert hashlib.sha256(index).hexdigest() == native.sha(args.dashboard / "index.html")
        assert headers.get("X-Content-Type-Options", headers.get("x-content-type-options")) == "nosniff"
        csp = headers.get("Content-Security-Policy", headers.get("content-security-policy", ""))
        assert "script-src 'self'" in csp and "'unsafe-eval'" not in csp
        _, help_page = request("/help/", opener=public)
        assert hashlib.sha256(help_page).hexdigest() == native.sha(args.dashboard / "help/index.html")
        _, missing = request("/help/does-not-exist/", opener=public, expected=404)
        assert hashlib.sha256(missing).hexdigest() == native.sha(args.dashboard / "help/404.html")
        asset = next((args.dashboard / "assets").glob("*.js"))
        _, downloaded_asset = request("/assets/" + asset.name, opener=public)
        assert hashlib.sha256(downloaded_asset).hexdigest() == native.sha(asset)
        _, spec_bytes = request("/api/v1/openapi.json")
        assert json.loads(spec_bytes) == json.loads((ROOT / "contracts/openapi.json").read_text())
        api("/releases", opener=public, expected=401)
        catalog = api("/releases")
        assert catalog, "Staged release catalog is empty"
        entry = next(e for e in catalog if e["os"] == "windows" and e["arch"] == "amd64")
        _, binary = request(entry["url"])
        assert hashlib.sha256(binary).hexdigest() == entry["sha256"] and len(binary) == entry["size"]
        assert entry["signed"] is False
        report["checks"].append({"name": "upgraded server delivers bundled app help API and verified unsigned release bytes", "passed": True, "app_index_sha256": hashlib.sha256(index).hexdigest(), "help_index_sha256": hashlib.sha256(help_page).hexdigest(), "help_missing_status": 404, "asset_sha256": hashlib.sha256(downloaded_asset).hexdigest(), "embedded_openapi_matches": True, "download_sha256": entry["sha256"], "download_bytes": len(binary), "signature_verified": False})
        last_seen = current()["last_seen"]
        agent = start_agent()
        until("existing agent credentials reconnect after upgrade and preserve verified workload", lambda: verified(version1, 3) if current()["last_seen"] != last_seen else None)
        assert native.sha(managed) == version1["sha256"]
        assert current()["configuration_attempt"]["state"] == "verified_applied"
        assert api("/deployments/" + replacement["id"] + "/targets")["items"][0]["state"] == "verified_applied"
        report["checks"].append({"name": "same agent identity resumes authenticated verification after server upgrade", "passed": True, "desired_generation": 3, "reported_generation": 3, "managed_bytes_preserved": True, "attempt_state": "verified_applied", "target_state": "verified_applied"})
        report["passed"] = True
        report["limitations"] = ["This is an upgrade from one preserved pre0016 development binary (all binaries still declare0.1.0), identified by exact SHA256; it does not qualify every historical migration chain.", "Only Windows native execution is exercised. Docker/Linux/macOS deployment, service-manager installation, public TLS/reverse proxy and trusted release signing remain separate gates.", "The isolated dashboard listener uses explicit development HTTP cookies on loopback; agent traffic uses real trusted TLS/mTLS. No production cookie/TLS termination configuration is certified.", "Startup intentionally invalidates pending login challenges; passwords, enrolled MFA, remaining recovery hashes, sessions, device credentials and deployment keys are preserved.", "No downgrade or restoration of an older security snapshot is performed or recommended. The offline backup is fixture-only and removed afterward."]
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        native.stop(agent)
        native.stop(server)
        for log in logs:
            log.close()
        report["processes_stopped"] = all(p is None or p.poll() is not None for p in [agent, server])
        assert temp.parent == Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-upgrade-proof-")
        shutil.rmtree(temp)
        report["private_fixture_removed"] = not temp.exists()
        report["harness_sha256"] = native.sha(__file__)
        report["helper_sha256"] = native.sha(HELPER)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print("Evidence: " + str(args.output), flush=True)


if __name__ == "__main__":
    main()
