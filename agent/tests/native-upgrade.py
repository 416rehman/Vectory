"""Disposable native Windows foreground upgrade qualification, never a live install.

Uses two actual release executables, fresh Rust TLS/enrollment and native Vector.
The existing attempt-review helper supplies isolated PKI and descendant-only stop.
Evidence contains digests/booleans, never credentials or rendered configuration.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import http.cookiejar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "tests/security/attempt-native.py"
spec = importlib.util.spec_from_file_location("attempt_review_helpers", HELPER)
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        path.chmod(0o700)
        return
    identity = subprocess.check_output(["whoami", "/user", "/fo", "csv", "/nh"], text=True)
    sid = next(csv.reader([identity.strip()]))[1]
    subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r",
                    f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"],
                   check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prior", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--server", type=Path, required=True)
    parser.add_argument("--vector", type=Path, default=ROOT / ".local/tools/vector-0.58.0/bin/vector.exe")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    paths = {key: getattr(args, key).resolve() for key in ("prior", "candidate", "server", "vector")}
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {
        "recorded_at": helpers.utc(), "passed": False,
        "scope": "Native Windows foreground binary replacement from an actual prior delivered executable to an extracted staged package. Fresh disposable TLS, enrollment, signed deployments, real Vector and loopback synthetic HTTP events. No live preview, OS service, reboot, installer, global trust or production state was accessed.",
        "binaries": {key: {"path": str(path), "sha256": digest(path)} for key, path in paths.items()},
        "checks": [], "modes": [],
        "limits": ["Same development version strings do not identify builds; exact package executable SHA256 values do.",
                   "This proves foreground replacement for these exact Windows builds, not SCM/MSI, reboot, other operating systems, arbitrary version pairs or downgrade compatibility.",
                   "Doctor/status are local diagnostics. Activation is checked separately using fresh authenticated heartbeats and real synthetic event delivery."]
    }
    assert os.name == "nt", "This qualification is specifically for Windows package replacement"
    assert report["binaries"]["prior"]["sha256"] != report["binaries"]["candidate"]["sha256"]
    temp = Path(tempfile.mkdtemp(prefix="vectory-native-upgrade-")).resolve()
    private_directory(temp)
    flags = subprocess.CREATE_NO_WINDOW
    server = agent = receiver = None
    handles = []
    secret = os.urandom(32).hex()
    event_count = 0
    try:
        server_binary = temp / "server.exe"
        shutil.copyfile(paths["server"], server_binary)
        helpers.pki(temp)
        http_port, tls_port = helpers.free_port(), helpers.free_port()
        origin, agent_origin = f"http://127.0.0.1:{http_port}", f"https://127.0.0.1:{tls_port}"
        bootstrap = os.urandom(32).hex()
        (temp / "bootstrap").write_text(bootstrap, encoding="utf-8")
        environment = {key: value for key, value in os.environ.items()
                       if not key.upper().startswith("VECTORY_") and key.upper() not in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")}
        environment.update(VECTORY_DATA_DIR=str(temp / "server-state"), VECTORY_HTTP_ADDR=f"127.0.0.1:{http_port}",
                           VECTORY_AGENT_ADDR=f"127.0.0.1:{tls_port}", VECTORY_TLS_CERT=str(temp / "server.pem"),
                           VECTORY_TLS_KEY=str(temp / "server-key.pem"), VECTORY_BOOTSTRAP_SECRET_FILE=str(temp / "bootstrap"),
                           VECTORY_DEVELOPMENT="true", VECTORY_COOKIE_SECURE="false", VECTORY_DASHBOARD_DIR=str(temp),
                           VECTORY_RELEASES_DIR=str(temp / "releases"), NO_COLOR="1")
        log = (temp / "server.log").open("wb"); handles.append(log)
        server = subprocess.Popen([str(server_binary)], env=environment, cwd=temp, stdout=log, stderr=log, creationflags=flags)
        cookies = http.cookiejar.CookieJar()
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(cookies))
        csrf = ""

        def api(path, body=None):
            req = urllib.request.Request(origin + "/api/v1" + path, data=None if body is None else json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
            try:
                with client.open(req, timeout=15) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                value = json.load(error)
                raise RuntimeError(f"Synthetic API {path}: HTTP {error.code} {value.get('error', {}).get('code')}") from None

        def until(label, condition, timeout=100):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if server.poll() is not None:
                    raise RuntimeError("Disposable server exited")
                result = condition()
                if result:
                    print("PASS " + label, flush=True)
                    return result
                time.sleep(0.3)
            raise AssertionError(label + " timed out")

        def ready():
            try: return api("/status")
            except urllib.error.URLError: return None

        until("disposable server ready", ready, 20)
        session = api("/bootstrap", {"bootstrap_secret": bootstrap, "name": "Synthetic upgrade qualification",
                                     "email": "upgrade@example.invalid", "password": os.urandom(24).hex()})
        csrf = session["csrf_token"]

        class Receiver(BaseHTTPRequestHandler):
            def do_POST(self):
                nonlocal event_count
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.headers.get("Authorization") == "Bearer " + secret:
                    event_count += 1
                self.send_response(200); self.end_headers()

            def do_GET(self):
                self.send_response(200); self.end_headers()

            def do_HEAD(self):
                self.send_response(200); self.end_headers()

            def log_message(self, *_):
                pass

        receiver = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        receiver.daemon_threads = True
        thread = threading.Thread(target=receiver.serve_forever, daemon=True); thread.start()
        sink_host = f"127.0.0.1:{receiver.server_port}"
        receiver_url = f"http://{sink_host}/events"

        for mode in ("restricted", "full"):
            work = temp / mode
            private_directory(work)
            binary = work / "vectory.exe"
            shutil.copyfile(paths["prior"], binary)
            state, config_dir, data_dir, secret_dir = (work / value for value in ("state", "managed", "data", "secrets"))
            for folder in (config_dir, data_dir, secret_dir): private_directory(folder)
            managed = config_dir / "vector.json"
            adopted = {"data_dir": str(data_dir), "sources": {"seed": {"type": "demo_logs", "format": "json", "interval": .1}},
                       "sinks": {"discard": {"type": "blackhole", "inputs": ["seed"]}}}
            managed.write_text(json.dumps(adopted), encoding="utf-8")
            secret_file = secret_dir / "token.txt"
            secret_file.write_text(secret + "\n", encoding="utf-8")
            bindings = work / "bindings.json"; bindings.write_text(json.dumps({"API_TOKEN": str(secret_file)}), encoding="utf-8")
            policy_file = work / "capabilities.json"
            policy_file.write_text(json.dumps({"allowed_file_roots": [str(data_dir)], "allowed_network_hosts": [sink_host],
                                              "allowed_listen_addresses": ["127.0.0.1:9598"]}), encoding="utf-8")
            cli_outputs = []

            def cli(*arguments, input=None, allow_failure=False, executable=None):
                result = subprocess.run([str(executable or binary), *arguments], cwd=work, env=environment, input=input,
                                        capture_output=True, text=True, timeout=45, creationflags=flags)
                cli_outputs.append(result.stdout + result.stderr)
                assert secret not in cli_outputs[-1], "Credential leaked into CLI diagnostics"
                if result.returncode and not allow_failure:
                    raise RuntimeError(f"{mode}: agent {arguments[0]} failed with exit {result.returncode}: {result.stdout[-500:]} {result.stderr[-500:]}")
                return result

            install = ["install", "--state-dir", str(state), "--vector-binary", str(paths["vector"]), "--managed-config", str(managed),
                       "--capability-policy", str(policy_file), "--secret-files", str(bindings), "--metrics-url", f"http://{sink_host}/metrics", "--adopt", "--json"]
            if mode == "full": install.append("--allow-full-vector-config")
            cli(*install)
            token = api("/tokens", {"name": "Synthetic upgrade fixture", "expires_hours": 1, "max_uses": 1, "name_prefix": "upgrade-"})
            cli("enroll", "--state-dir", str(state), "--server", agent_origin, "--ca-file", str(temp / "ca.pem"),
                "--id", "upgrade-" + mode + "-" + uuid.uuid4().hex[:8], "--token-stdin", "--json", input=token["token"] + "\n")
            local = lambda: json.loads((state / "state.json").read_text())
            device_id = local()["device_id"]
            current = lambda: api("/devices/" + device_id)
            rollout = {"kind": "all", "canary_size": 1, "batch_size": 1, "observation_seconds": 1, "failure_threshold": 0}

            def deploy(version=None, policy=None, priority=100):
                return api("/deployments", {"selector": {"device_ids": [device_id], "group_ids": [], "exclude_ids": []},
                                           "expected_device_ids": [device_id], "target_mode": "snapshot", "priority": priority, "rollout": rollout,
                                           **({"version_id": version["id"]} if version else {"policy": policy})})

            def publish(config, name):
                draft = api("/configurations", {"name": name, "description": "Disposable native upgrade qualification", "config": config,
                                                "graph": {"nodes": [], "edges": []}})
                return api("/configurations/" + draft["id"] + "/publish", {"revision": draft["revision"], "message": "Synthetic native upgrade"})

            deploy(policy={"heartbeat_seconds": 10, "sync_paused": False, "telemetry_enabled": False})
            good = {**adopted, "sinks": {"out": {"type": "http", "inputs": ["seed"], "uri": receiver_url,
                                                  "encoding": {"codec": "json"}, "batch": {"timeout_secs": .1},
                                                  "auth": {"strategy": "bearer", "token": "vectory-secret:API_TOKEN"}}}}
            version = publish(good, "Synthetic " + mode + " secret baseline")
            deploy(version)
            agent_log = (work / "agent.log").open("wb"); handles.append(agent_log)

            def start():
                return subprocess.Popen([str(binary), "run", "--state-dir", str(state), "--json"], cwd=work, env=environment,
                                        stdout=agent_log, stderr=agent_log, creationflags=flags)

            agent = start()
            seen_before = event_count

            def verified():
                d = current()
                return d if d.get("apply_state") == "verified_applied" and d.get("reported_generation") == d.get("desired_generation") and d.get("applied_template_sha256") == version["sha256"] and event_count > seen_before else None

            first = until(mode + " prior package verified native secret workload", verified)
            first_local = local()
            first_managed = digest(managed)
            assert first_managed == first_local["last_good_sha256"] != version["sha256"]
            settings_before_lock = digest(state / "settings.json")
            locked = cli("install", "--state-dir", str(state), "--json", executable=paths["candidate"], allow_failure=True)
            assert locked.returncode == 1 and digest(state / "settings.json") == settings_before_lock

            bad = json.loads(json.dumps(good))
            bad["transforms"] = {"broken": {"type": "remap", "inputs": ["seed"], "source": ". = "}}
            bad["sinks"]["out"]["inputs"] = ["broken"]
            bad_version = publish(bad, "Synthetic " + mode + " legacy rejected candidate")
            deploy(bad_version, priority=200)

            def legacy_failure():
                s = local()
                return s if s.get("failed_generation") == current()["desired_generation"] and s.get("error", {}).get("code") == "VALIDATION_FAILED" else None

            failed = until(mode + " prior package cached native rejection", legacy_failure)
            assert not failed.get("configuration_attempt")
            cli("pause", "--state-dir", str(state), "--json")
            until(mode + " durable local pause acknowledged", lambda: current().get("local_paused"))
            helpers.stop(agent); agent = None
            before_state = local()
            preserved_paths = [state / "settings.json", state / "identity.json", state / "adoption-backup.json", state / "paused", managed, secret_file]
            preserved_paths += list(state.glob("good-*.json")) + list(state.glob("template-*.json"))
            preserved = {str(path.relative_to(work)): digest(path) for path in preserved_paths}
            state_hash = digest(state / "state.json")
            shutil.copyfile(binary, work / "vectory.previous.exe")
            shutil.copyfile(paths["candidate"], binary)
            assert digest(binary) == report["binaries"]["candidate"]["sha256"]
            cli("install", "--state-dir", str(state), "--json")
            status = json.loads(cli("status", "--state-dir", str(state), "--json").stdout)
            doctor = json.loads(cli("doctor", "--state-dir", str(state), "--json").stdout)
            assert digest(state / "state.json") == state_hash, "Install/status/doctor mutated old local state"
            assert all(digest(work / name) == value for name, value in preserved.items()), "Upgrade changed preserved content"
            assert doctor["binary_integrity"] and doctor["configuration_mode"] == mode and status["local_paused"]
            assert status["state"]["failed_generation"] == before_state["failed_generation"]

            seen_before = event_count
            agent = start()
            until(mode + " candidate restarts preserved workload while paused", lambda: current().get("local_paused") and event_count > seen_before)
            after_restart = local()
            counter_fields = ["device_id", "highest_generation", "highest_policy_generation", "reported_generation", "secret_revision", "applied_secret_revision", "last_good_sha256", "applied_template_sha256", "failed_generation", "failed_effective_sha256"]
            assert all(after_restart.get(key) == before_state.get(key) for key in counter_fields)
            assert all(digest(work / name) == value for name, value in preserved.items())
            assert current()["configuration_mode"] == mode and len(api("/devices")) == len(report["modes"]) + 1

            cli("resume", "--state-dir", str(state), "--json")
            previous_heartbeat = local().get("last_heartbeat")
            until(mode + " explicit resume retains legacy failure suppression", lambda: not current().get("local_paused") and local().get("last_heartbeat") != previous_heartbeat)
            suppressed = local()
            assert suppressed["failed_generation"] == before_state["failed_generation"]
            assert suppressed.get("configuration_attempt", {}).get("state") not in ("failed", "rolled_back")
            assert suppressed["reported_generation"] == first_local["reported_generation"] and digest(managed) == first_managed
            helpers.stop(agent); agent = None
            before_retry = local()
            cli("retry", "--state-dir", str(state), "--json")
            after_retry = local()
            assert not after_retry.get("failed_generation") and not after_retry.get("failed_effective_sha256")
            assert all(after_retry.get(key) == before_retry.get(key) for key in counter_fields if key not in ("failed_generation", "failed_effective_sha256"))
            agent = start()

            def fresh_failure():
                d = current(); attempt = d.get("configuration_attempt") or {}
                return d if attempt.get("generation") == before_state["highest_generation"] and attempt.get("version_id") == bad_version["id"] and attempt.get("state") == "failed" else None

            retried = until(mode + " explicit stopped retry obtains fresh candidate failure evidence", fresh_failure)
            assert retried["reported_generation"] == first_local["reported_generation"] and digest(managed) == first_managed
            repaired = publish(good, "Synthetic " + mode + " reviewed repair")
            deploy(repaired, priority=300)
            version = repaired
            seen_before = event_count
            final = until(mode + " reviewed replacement verifies after upgrade", verified)
            assert final["id"] == device_id and final["configuration_mode"] == mode
            assert digest(state / "identity.json") == preserved["state/identity.json" if os.name != "nt" else "state\\identity.json"]
            assert digest(state / "settings.json") == settings_before_lock
            assert all(secret not in text for text in cli_outputs)
            for path in [state / "state.json", work / "agent.log"]:
                assert secret not in path.read_text(encoding="utf-8", errors="replace"), "Credential leaked into operational metadata"
            helpers.stop(agent); agent = None
            report["modes"].append({"mode": mode, "passed": True, "identity_preserved": True, "enrollment_count": 1,
                                    "settings_and_secret_bindings_preserved": True, "state_unchanged_by_install_status_doctor": True,
                                    "local_pause_preserved_through_restart": True, "real_secret_authenticated_events_after_restart": True,
                                    "legacy_failure_suppression_preserved_until_explicit_retry": True, "fresh_attempt_after_retry": True,
                                    "live_install_refused_exit": locked.returncode, "before_counters": {key: before_state.get(key) for key in counter_fields},
                                    "after_restart_counters": {key: after_restart.get(key) for key in counter_fields},
                                    "final_verified_generation": final["reported_generation"], "preserved_file_sha256": preserved})
        report["checks"] = [{"name": name, "passed": True} for name in [
            "Actual prior-package adoption, enrollment and signed native secret activation in both local modes",
            "Candidate install refuses a state directory locked by the prior live agent",
            "Stopped executable replacement plus install/status/doctor preserves private state bytes",
            "Restart retains identity, adoption, local pause, settings, effective last-good and secret bindings",
            "Upgrade/resume does not guess or retry an old suppressed failure; explicit stopped retry creates fresh evidence",
            "A reviewed newer replacement verifies through real mTLS and real native event delivery"]]
        report["passed"] = True
    except Exception as error:
        report["failure"] = str(error).replace(secret, "[redacted]")
        raise
    finally:
        helpers.stop(agent); helpers.stop(server)
        if receiver is not None: receiver.shutdown(); receiver.server_close()
        for handle in handles: handle.close()
        report["processes_stopped"] = all(process is None or process.poll() is not None for process in (agent, server))
        assert temp.parent == Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-native-upgrade-")
        shutil.rmtree(temp)
        report["private_fixture_removed"] = not temp.exists()
        report["harness_sha256"] = digest(__file__)
        report["helper_sha256"] = digest(HELPER)
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print("Evidence: " + str(args.output / "report.json"), flush=True)


if __name__ == "__main__":
    main()
