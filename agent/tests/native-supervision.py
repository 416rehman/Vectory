"""Disposable real-process child recovery proof; never inspects live agents.

Fresh TLS/server/device/workload. Terminates only the exact Vector descendant of
this fixture's agent, then observes authenticated heartbeats and HTTP events.
"""
from __future__ import annotations
import argparse
import http.cookiejar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("upgrade_helpers", Path(__file__).with_name("native-upgrade.py"))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
helpers = upgrade.helpers


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", type=Path, required=True)
    parser.add_argument("--server", type=Path, required=True)
    parser.add_argument("--vector", type=Path, default=ROOT / ".local/tools/vector-0.58.0/bin/vector.exe")
    parser.add_argument("--expect", choices=("before", "after"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output = args.output.resolve(); args.output.mkdir(parents=True, exist_ok=True)
    paths = {key: getattr(args, key).resolve() for key in ("agent", "server", "vector")}
    report = {"recorded_at": helpers.utc(), "passed": False, "expectation": args.expect,
              "scope": "Disposable real Rust/TLS/Go/Vector foreground processes and synthetic loopback HTTP events. Only fixture-owned Vector descendants are terminated. No preview state, credentials, services or global trust accessed.",
              "binaries": {key: {"path": str(value), "sha256": upgrade.digest(value)} for key, value in paths.items()}, "checks": [], "harness_sha256": upgrade.digest(__file__),
              "source_sha256": {str(p.relative_to(ROOT)): upgrade.digest(p) for p in (ROOT / "agent/internal/agent/reconcile.go", ROOT / "agent/internal/agent/vector.go", ROOT / "agent/internal/agent/supervision.go") if p.exists()}}
    temp = Path(tempfile.mkdtemp(prefix="vectory-supervision-")).resolve()
    upgrade.private_directory(temp)
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    server = agent = receiver = stalled = None
    handles = []
    count = 0
    try:
        helpers.pki(temp)
        for key in ("agent", "server"):
            copied = temp / (key + paths[key].suffix)
            shutil.copyfile(paths[key], copied); copied.chmod(0o700)
            paths[key] = copied
        http_port, tls_port = helpers.free_port(), helpers.free_port()
        origin, agent_origin = f"http://127.0.0.1:{http_port}", f"https://127.0.0.1:{tls_port}"
        bootstrap = os.urandom(32).hex(); (temp / "bootstrap").write_text(bootstrap)
        env = {key: value for key, value in os.environ.items() if not key.upper().startswith("VECTORY_") and key.upper() not in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")}
        env.update(VECTORY_DATA_DIR=str(temp / "server-state"), VECTORY_HTTP_ADDR=f"127.0.0.1:{http_port}", VECTORY_AGENT_ADDR=f"127.0.0.1:{tls_port}", VECTORY_TLS_CERT=str(temp / "server.pem"), VECTORY_TLS_KEY=str(temp / "server-key.pem"), VECTORY_BOOTSTRAP_SECRET_FILE=str(temp / "bootstrap"), VECTORY_DEVELOPMENT="true", VECTORY_COOKIE_SECURE="false", VECTORY_DASHBOARD_DIR=str(temp), VECTORY_RELEASES_DIR=str(temp / "releases"), NO_COLOR="1")
        log = (temp / "server.log").open("wb"); handles.append(log)
        server = subprocess.Popen([str(paths["server"])], env=env, cwd=temp, stdout=log, stderr=log, creationflags=flags)
        cookies = http.cookiejar.CookieJar()
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(cookies))
        csrf = ""

        def api(path, body=None):
            req = urllib.request.Request(origin + "/api/v1" + path, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
            try:
                with client.open(req, timeout=15) as response: return json.load(response)
            except urllib.error.HTTPError as error:
                value = json.load(error)
                raise RuntimeError(f"Synthetic API {path}: HTTP {error.code} {value.get('error', {}).get('code')}") from None

        def until(label, condition, timeout=100):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                value = condition()
                if value:
                    print("PASS " + label, flush=True); return value
                time.sleep(.25)
            raise AssertionError(label + " timed out")

        def ready():
            try: return api("/status")
            except urllib.error.URLError: return None
        until("isolated server ready", ready, 20)
        session = api("/bootstrap", {"bootstrap_secret": bootstrap, "name": "Synthetic supervision proof", "email": "supervision@example.invalid", "password": os.urandom(24).hex()})
        csrf = session["csrf_token"]

        class Receiver(BaseHTTPRequestHandler):
            def do_POST(self):
                nonlocal count
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                count += 1
                self.send_response(200); self.end_headers()
            def do_GET(self): self.send_response(200); self.end_headers()
            def do_HEAD(self): self.send_response(200); self.end_headers()
            def log_message(self, *_): pass
        receiver = ThreadingHTTPServer(("127.0.0.1", 0), Receiver); receiver.daemon_threads = True
        threading.Thread(target=receiver.serve_forever, daemon=True).start()
        state, config_dir, data_dir = (temp / value for value in ("state", "managed", "data"))
        for folder in (config_dir, data_dir): upgrade.private_directory(folder)
        managed = config_dir / "vector.json"
        host = f"127.0.0.1:{receiver.server_port}"
        good = {"data_dir": str(data_dir), "sources": {"seed": {"type": "demo_logs", "format": "json", "interval": .1}}, "sinks": {"out": {"type": "http", "inputs": ["seed"], "uri": f"http://{host}/events", "encoding": {"codec": "json"}, "batch": {"timeout_secs": .1}}}}
        managed.write_text(json.dumps(good))
        policy_file = temp / "capabilities.json"; policy_file.write_text(json.dumps({"allowed_file_roots": [str(data_dir)], "allowed_network_hosts": [host]}))

        def cli(*arguments, input=None):
            result = subprocess.run([str(paths["agent"]), *arguments], cwd=temp, env=env, input=input, capture_output=True, text=True, timeout=45, creationflags=flags)
            assert result.returncode == 0, f"Agent {arguments[0]} failed: {result.returncode}"
            return result
        cli("install", "--state-dir", str(state), "--vector-binary", str(paths["vector"]), "--managed-config", str(managed), "--capability-policy", str(policy_file), "--adopt", "--json")
        token = api("/tokens", {"name": "Synthetic supervision", "expires_hours": 1, "max_uses": 1, "name_prefix": "supervision-"})
        cli("enroll", "--state-dir", str(state), "--server", agent_origin, "--ca-file", str(temp / "ca.pem"), "--id", "supervision-" + uuid.uuid4().hex[:8], "--token-stdin", "--json", input=token["token"] + "\n")
        def local():
            # Windows replacement briefly holds a nonshared handle. Only retry
            # that OS sharing failure; invalid JSON/other read errors still fail.
            deadline = time.monotonic() + 2
            while True:
                try: return json.loads((state / "state.json").read_text())
                except PermissionError:
                    if time.monotonic() >= deadline: raise
                    time.sleep(.02)
        device_id = local()["device_id"]
        current = lambda: api("/devices/" + device_id)
        rollout = {"kind": "all", "canary_size": 1, "batch_size": 1, "observation_seconds": 1, "failure_threshold": 0}
        def deploy(version=None, policy=None, priority=100):
            return api("/deployments", {"selector": {"device_ids": [device_id], "group_ids": [], "exclude_ids": []}, "expected_device_ids": [device_id], "target_mode": "snapshot", "priority": priority, "rollout": rollout, **({"version_id": version["id"]} if version else {"policy": policy})})
        def publish(config, name):
            draft = api("/configurations", {"name": name, "description": "Disposable native supervision", "config": config, "graph": {"nodes": [], "edges": []}})
            return api("/configurations/" + draft["id"] + "/publish", {"revision": draft["revision"], "message": "Synthetic supervision"})
        deploy(policy={"heartbeat_seconds": 10, "sync_paused": False, "telemetry_enabled": False})
        good_version = publish(good, "Synthetic known good workload")
        good_deployment = deploy(good_version)
        log = (temp / "agent.log").open("wb"); handles.append(log)
        def start():
            return subprocess.Popen([str(paths["agent"]), "run", "--state-dir", str(state), "--json"], env=env, cwd=temp, stdout=log, stderr=log, creationflags=flags)
        agent = start()
        until("real verified baseline and events", lambda: current().get("apply_state") == "verified_applied" and count > 0)

        def owned_child():
            children = helpers.psutil.Process(agent.pid).children(recursive=True)
            selected = []
            for process in children:
                try:
                    expected_args = ["--config-json", str(managed), "--log-format", "json", "--require-healthy", "true"]
                    if Path(process.exe()).resolve() == paths["vector"] and process.cmdline()[1:] == expected_args:
                        selected.append(process)
                except helpers.psutil.NoSuchProcess:
                    pass
            assert len(selected) <= 1, "More than one exact fixture-owned Vector process"
            return selected[0] if selected else None

        def stable_child():
            deadline = time.monotonic() + 45
            identity = None; began = 0; initial_count = count; last_count = count; last_event = 0
            while time.monotonic() < deadline:
                process = owned_child()
                current_identity = (process.pid, process.create_time()) if process else None
                now = time.monotonic()
                if not current_identity or current_identity != identity:
                    identity = current_identity; began = now; initial_count = count; last_event = now
                if count > last_count:
                    last_event = now
                last_count = count
                # Native activation requires two seconds after its startup
                # record. Wait beyond that interval, with continuing events,
                # so the following kill is not a startup-phase failure.
                if identity and now - began >= 3.5 and count > initial_count and now - last_event < 1.5:
                    return identity, round(now - began, 1)
                time.sleep(.2)
            raise AssertionError("Exact owned Vector child did not establish stable liveness and continuing event delivery")

        def kill_child(expected):
            selected = [p for p in (owned_child(),) if p]
            assert len(selected) == 1, "Expected one exact fixture-owned Vector process"
            victim = selected[0]; identity = (victim.pid, victim.create_time())
            assert identity == expected, "Owned Vector child changed after the steady baseline"
            victim.kill(); victim.wait(timeout=8)
            time.sleep(.4)
            assert agent.poll() is None
            return identity

        counters = ("reported_generation", "secret_revision", "applied_secret_revision", "last_good_sha256", "applied_template_sha256")
        def observe(name, online=True, paused=False, timeout=28, check_blocked=False):
            baseline_identity, baseline_seconds = stable_child()
            before = local(); heartbeat = before.get("last_heartbeat")
            killed = kill_child(baseline_identity); begin_count = count; started = time.monotonic(); recovery_seconds = None
            replacement = None; replacement_since = None; replacement_count = count
            last_count = count; last_event = started; replacement_stable_seconds = 0; recovered = False
            while time.monotonic() - started < timeout:
                assert agent.poll() is None, "Agent exited after child death"
                now = time.monotonic()
                process = owned_child()
                identity = (process.pid, process.create_time()) if process else None
                assert identity != killed, "Terminated Vector identity remained present"
                if identity != replacement:
                    replacement = identity; replacement_since = now if identity else None; replacement_count = count
                if count > last_count:
                    last_event = now
                last_count = count
                if check_blocked and time.monotonic() - started < 5:
                    assert not identity and count == begin_count, "Unexpected concurrent engine recovery during held network call"
                if paused:
                    assert not identity, "Paused workload was restarted"
                if replacement and count > replacement_count and recovery_seconds is None:
                    recovery_seconds = round(time.monotonic() - started, 1)
                replacement_stable_seconds = now - replacement_since if replacement_since else 0
                recovered = bool(replacement and replacement_stable_seconds >= 3 and count > replacement_count and now - last_event < 1.5)
                if args.expect == "after" and not paused and recovered and (not online or local().get("last_heartbeat") != heartbeat):
                    break
                time.sleep(.3)
            after = local()
            assert all(after.get(k) == before.get(k) for k in counters), "Recovery changed verified identity/counters"
            assert after.get("configuration_attempt") == before.get("configuration_attempt") or (before.get("configuration_attempt", {}).get("state") == "verified_applied" and after.get("configuration_attempt", {}).get("state") in ("verified_applied", "verification_unknown")), "Recovery replaced candidate attribution"
            if online: assert after.get("last_heartbeat") != heartbeat, "No fresh heartbeat observed"
            expected = args.expect == "after" and not paused
            report["checks"].append({"name": name, "passed": recovered == expected, "observed_seconds": round(time.monotonic()-started, 1), "recovery_seconds": recovery_seconds, "agent_remained_alive": True, "events_recovered": recovered, "fresh_heartbeat": after.get("last_heartbeat") != heartbeat, "verified_counters_preserved": True, "candidate_identity_preserved": True, "killed_fixture_pid": killed[0], "killed_fixture_created_at": killed[1], "baseline_stable_seconds": baseline_seconds, "replacement_pid": replacement[0] if replacement else None, "replacement_created_at": replacement[1] if replacement else None, "replacement_stable_seconds": round(replacement_stable_seconds, 1), "continuing_events_from_replacement": recovered, "observed_apply_state": after.get("apply_state"), "observed_error_code": after.get("error", {}).get("code")})
            assert recovered == expected, f"{name}: event recovery={recovered}, expected={expected}"
            print("PASS " + name, flush=True)
            return recovered

        bad = json.loads(json.dumps(good)); bad["transforms"] = {"broken": {"type": "remap", "inputs": ["seed"], "source": ". = "}}; bad["sinks"]["out"]["inputs"] = ["broken"]
        bad_version = publish(bad, "Synthetic rejected candidate")
        bad_deployment = deploy(bad_version, priority=200)
        until("candidate rejected while good workload lives", lambda: local().get("failed_generation") == current().get("desired_generation"))
        observe("Suppressed failed candidate does not prevent established workload recovery")
        if args.expect == "before":
            helpers.stop(agent); agent = start(); baseline = count
            until("explicit agent restart restores workload control", lambda: count > baseline)

        cli("pause", "--state-dir", str(state), "--json")
        until("local pause acknowledged", lambda: current().get("local_paused"))
        observe("Local pause prevents watchdog restart", paused=True, timeout=16)
        cli("resume", "--state-dir", str(state), "--json")
        if args.expect == "before":
            helpers.stop(agent); agent = start()
        baseline = count
        until("explicit resume permits workload recovery", lambda: count > baseline)

        for deployment in (bad_deployment, good_deployment): api("/deployments/" + deployment["id"] + "/unassign", {})
        until("unassigned retained workload", lambda: not current().get("desired_version_id") and local().get("apply_state") == "unmanaged")
        if args.expect == "after":
            # Independent scenarios start with fresh local backoff. No restart
            # occurs during a measured child-death/recovery interval.
            helpers.stop(agent); agent = start(); baseline = count
            until("fresh supervisor baseline for unmanaged case", lambda: count > baseline)
        observe("Unassigned adopted workload recovers without a deployment")
        if args.expect == "before":
            helpers.stop(agent); agent = start(); baseline = count
            until("restart restores unmanaged control", lambda: count > baseline)

        deploy(good_version, priority=300)
        until("baseline verified before outage", lambda: current().get("apply_state") == "verified_applied")
        if args.expect == "after":
            helpers.stop(agent); agent = start(); baseline = count
            until("fresh supervisor baseline for outage case", lambda: count > baseline)
        helpers.stop(server); server = None
        observe("Control-plane outage does not prevent established workload recovery", online=False)
        if args.expect == "after":
            helpers.stop(agent)
            held = threading.Event()
            held_paths = []
            class StalledHeartbeat(BaseHTTPRequestHandler):
                def do_POST(self):
                    self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    held_paths.append(self.path)
                    held.set()
                    time.sleep(40)  # Longer than the agent's 30s whole-request deadline.
                def log_message(self, *_): pass
            stalled = ThreadingHTTPServer(("127.0.0.1", tls_port), StalledHeartbeat)
            stalled.daemon_threads = True
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(temp / "server.pem", temp / "server-key.pem")
            stalled.socket = tls.wrap_socket(stalled.socket, server_side=True)
            threading.Thread(target=stalled.serve_forever, daemon=True).start()
            agent = start(); baseline = count
            until("fresh supervisor baseline for held-request case", lambda: count > baseline)
            until("fresh trusted fixture server holds an outbound request", held.is_set, 100)
            observe("Bounded in-flight request delays local recovery; renewal does not add a second request wait", online=False, timeout=45, check_blocked=True)
            report["held_request_paths"] = held_paths
            report["scenario_isolation"] = "The agent is restarted between independent unmanaged/outage/held-request cases to reset prior-case backoff; never between killing its Vector child and observing automatic event recovery. Flapping/backoff accumulation is covered separately by deterministic engine tests."
            report["limits"] = ["Engine state and native recovery are serialized. Each outbound request has a 30s deadline, with a local health check between renewal and heartbeat. Native validation/activation can also delay checks, so the five-second tick is not an end-to-end recovery guarantee.", "Restart checks respect local and server sync pause and preserve the separate failed candidate. No graceful-shutdown, delivery-loss or service-manager guarantee is established."]
        report["passed"] = True
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        helpers.stop(agent); helpers.stop(server)
        if receiver is not None: receiver.shutdown(); receiver.server_close()
        if stalled is not None: stalled.shutdown(); stalled.server_close()
        for handle in handles: handle.close()
        report["processes_stopped"] = all(p is None or p.poll() is not None for p in (agent, server))
        assert temp.parent == Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-supervision-")
        shutil.rmtree(temp); report["private_fixture_removed"] = not temp.exists()
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print("Evidence: " + str(args.output / "report.json"), flush=True)


if __name__ == "__main__": main()
