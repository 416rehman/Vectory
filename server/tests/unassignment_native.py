"""Disposable real-HTTP proof of reviewed assignment-removal scope.

Only synthetic device identities and immutable fixture versions are used. No
agent connects and no real workload activation is claimed.
"""
import argparse
import contextlib
import hashlib
import http.cookiejar
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("native_helpers", ROOT / "tests/security/attempt-native.py")
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--server", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--expect", choices=["before", "after"], default="before")
args = parser.parse_args()
report = {"recorded_at": h.utc(), "scope": __doc__, "server_sha256": h.sha(args.server), "passed": False,
          "expect": args.expect,
          "qualification": "Expected-defect reproduction; not acceptance." if args.expect == "before" else "Native HTTP stale-review rejection and fresh-confirmation qualification."}
temp = Path(tempfile.mkdtemp(prefix="vectory-unassignment-review-")).resolve()
process = log = None
try:
    binary = temp / "server.exe"
    shutil.copyfile(args.server, binary)
    port = h.free_port()
    origin = f"http://127.0.0.1:{port}"
    bootstrap = os.urandom(32).hex()
    password = os.urandom(32).hex()
    (temp / "bootstrap").write_text(bootstrap)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("VECTORY_") and k.upper() not in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]}
    env.update(VECTORY_DATA_DIR=str(temp / "state"), VECTORY_HTTP_ADDR=f"127.0.0.1:{port}", VECTORY_DEVELOPMENT="true", VECTORY_COOKIE_SECURE="false", VECTORY_BOOTSTRAP_SECRET_FILE=str(temp / "bootstrap"), VECTORY_DASHBOARD_DIR=str(temp), VECTORY_RELEASES_DIR=str(temp / "releases"))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    csrf = ""

    def api(path, body=None, method=None, expected=200):
        req = urllib.request.Request(origin + "/api/v1" + path, data=None if body is None else json.dumps(body).encode(), method=method, headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
        try:
            response = opener.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.status
            value = json.load(response)
        assert status == expected, f"{req.method} {path}: {status}, expected {expected}"
        return value

    log = (temp / "server.log").open("ab")
    process = subprocess.Popen([str(binary)], cwd=temp, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(150):
        try:
            api("/status")
            break
        except urllib.error.URLError:
            time.sleep(.1)
    else:
        raise AssertionError("Fixture startup timeout")
    csrf = api("/bootstrap", {"bootstrap_secret": bootstrap, "name": "Synthetic administrator", "email": "admin@example.invalid", "password": password})["csrf_token"]
    database = temp / "state/vectory.db"
    devices = [str(uuid.uuid4()) for _ in range(3)]
    versions = [str(uuid.uuid4()) for _ in range(3)]
    config_id = str(uuid.uuid4())
    now = h.utc()
    with contextlib.closing(sqlite3.connect(database)) as db:
        for index, device in enumerate(devices):
            data = {"id": device, "name": f"Synthetic target {index}", "os": "linux", "arch": "amd64", "vector_version": "0.58.0", "agent_version": "synthetic", "last_seen": now, "apply_state": "unmanaged", "reported_generation": 0, "created_at": now}
            db.execute("INSERT INTO devices(id,name,data) VALUES(?,?,?)", (device, data["name"], json.dumps(data)))
        for index, version in enumerate(versions):
            data = {"id": version, "configuration_id": config_id, "number": index + 1, "artifact": "{}\n", "sha256": hashlib.sha256(b"{}\n").hexdigest(), "size": 3, "created_at": now}
            db.execute("INSERT INTO records(kind,id,data,created_at) VALUES('version',?,?,?)", (version, json.dumps(data), now))
        db.commit()

    def deploy(ids, priority, version, group=None):
        return api("/deployments", {"selector": {"device_ids": [] if group else ids, "group_ids": [group] if group else [], "exclude_ids": []}, "expected_device_ids": ids, "version_id": version, "priority": priority, "target_mode": "persistent" if group else "snapshot", "scheduled_at": None, "rollout": {"kind": "all", "canary_size": 1, "batch_size": 1, "observation_seconds": 60, "failure_threshold": 0}})

    def delivery(device):
        value = api("/devices/" + device)
        return {k: value.get(k) for k in ["id", "assignment", "desired_version_id", "desired_generation", "reported_generation"]}

    fallback = deploy(devices[:2], 10, versions[0])
    group = api("/groups", {"name": "Synthetic reviewed group", "description": "", "device_ids": devices[:1]})
    source = deploy(devices[:1], 20, versions[1], group["id"])
    path = "/deployments/" + source["id"]
    preview = api(path + "/unassign-preview", {})
    assert [d["device_id" if args.expect == "after" else "id"] for d in preview["devices"]] == devices[:1]
    api("/groups/" + group["id"], {"name": group["name"], "description": "", "device_ids": devices[:2], "revision": group["revision"]}, method="PUT")
    before = delivery(devices[1])
    assert before["desired_version_id"] == versions[1]
    bodies = {}
    def snapshot():
        with contextlib.closing(sqlite3.connect(database)) as db:
            return {table: db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall() for table in ["records", "devices", "deployment_targets"]}
    if args.expect == "after":
        stable = snapshot()
        error = api(path + "/unassign", {"review_token": preview["review_token"]}, expected=409)
        assert error["error"]["code"] == "ASSIGNMENT_REMOVAL_REVIEW_CHANGED"
        assert snapshot() == stable
        fresh = api(path + "/unassign-preview", {})
        assert len(fresh["devices"]) == 2 and fresh["ready"]
        result = api(path + "/unassign", {"review_token": fresh["review_token"]})
        bodies.update(native_membership_stale_error=error, native_membership_preview=fresh, native_membership_result=result)
    else:
        result = api(path + "/unassign", {})
    after = delivery(devices[1])
    assert result["status"] == "unassigned"
    assert after["desired_version_id"] == versions[0]
    assert after["desired_generation"] == before["desired_generation"] + 1
    assert after["reported_generation"] == before["reported_generation"] == 0
    membership = {"reviewed_device_ids": [d["device_id" if args.expect == "after" else "id"] for d in preview["devices"]], "added_unreviewed_device_id": devices[1], "source_deployment_id": source["id"], "fallback_deployment_id": fallback["id"], "before_commit": before, "after_commit": after, "source_status": result["status"], "fresh_review_required": args.expect == "after"}

    old_fallback = deploy(devices[2:], 10, versions[0])
    source2 = deploy(devices[2:], 100, versions[1])
    path2 = "/deployments/" + source2["id"]
    preview2 = api(path2 + "/unassign-preview", {})
    reviewed = preview2["devices"][0]
    reviewed_version = reviewed["after"]["version_id"] if args.expect == "after" else reviewed["desired_version_id"]
    assert reviewed_version == versions[0]
    before2 = delivery(devices[2])
    new_fallback = deploy(devices[2:], 50, versions[2])
    assert delivery(devices[2]) == before2, "Competing lower candidate must not change the currently delivered assignment"
    if args.expect == "after":
        stable = snapshot()
        error = api(path2 + "/unassign", {"review_token": preview2["review_token"]}, expected=409)
        assert error["error"]["code"] == "ASSIGNMENT_REMOVAL_REVIEW_CHANGED"
        assert snapshot() == stable
        fresh2 = api(path2 + "/unassign-preview", {})
        assert fresh2["devices"][0]["after"]["version_id"] == versions[2]
        # Deliberately leave the committed response completely unread. Recovery
        # checks the exact source state after a real same-store restart.
        req = urllib.request.Request(origin + "/api/v1" + path2)
        for handler in opener.handlers:
            if isinstance(handler, urllib.request.HTTPCookieProcessor):
                handler.cookiejar.add_cookie_header(req)
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
        connection.request("POST", "/api/v1" + path2 + "/unassign", body=json.dumps({"review_token": fresh2["review_token"]}), headers={"Content-Type": "application/json", "X-CSRF-Token": csrf, "Cookie": req.get_header("Cookie")})
        for _ in range(120):
            with contextlib.closing(sqlite3.connect(database)) as db:
                current = db.execute("SELECT json_extract(data,'$.status') FROM records WHERE kind='deployment' AND id=?", (source2["id"],)).fetchone()[0]
            if current == "unassigned":
                break
            time.sleep(.05)
        else:
            raise AssertionError("Reviewed removal did not commit")
        connection.close()
        h.stop(process); log.close(); process = log = None
        log = (temp / "server.log").open("ab")
        process = subprocess.Popen([str(binary)], cwd=temp, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(150):
            try:
                api("/status"); break
            except urllib.error.URLError:
                time.sleep(.1)
        summary = api(path2 + "/summary")
        assert summary["id"] == source2["id"] and summary["status"] == "unassigned"
        stable = snapshot()
        api(path2 + "/unassign", {"review_token": fresh2["review_token"]}, expected=409)
        assert snapshot() == stable
        with contextlib.closing(sqlite3.connect(database)) as db:
            audits = db.execute("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.unassign'").fetchone()[0]
        assert audits == 2
        bodies.update(native_fallback_stale_error=error, native_fallback_preview=fresh2, native_confirmed_summary=summary)
        report.update(committed_response_never_read=True, restart_exact_source_confirmation=True, removal_audit_count=audits,
                      stale_rejections_unchanged=True, repeated_old_confirmation_rejected=True)
    else:
        api(path2 + "/unassign", {})
    after2 = delivery(devices[2])
    assert after2["desired_version_id"] == versions[2] != reviewed_version
    fallback_race = {"device_id": devices[2], "source_deployment_id": source2["id"], "reviewed_fallback_id": old_fallback["id"], "reviewed_version_id": reviewed_version, "new_fallback_id": new_fallback["id"], "before_commit": before2, "after_commit": after2, "fresh_review_required": args.expect == "after"}
    if args.expect == "after":
        directory = ROOT / ".local/assignment-removal-native-bodies"
        directory.mkdir(parents=True, exist_ok=True)
        manifest = []
        for name, value in bodies.items():
            (directory / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")
            schema = "AssignmentRemovalPreview" if name.endswith("preview") else "Error" if name.endswith("error") else "DeploymentSummary" if name.endswith("summary") else "Deployment"
            manifest.append({"file": name + ".json", "schema": schema})
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        assert api("/openapi.json") == json.loads((ROOT / "contracts/openapi.json").read_text())
        report["embedded_openapi_matches_current"] = True
    report.update(passed=True, groups=2, membership_expansion=membership, fallback_change=fallback_race, activation_claimed=False,
                  source_sha256={p: h.sha(ROOT / p) for p in ["server/src/api.rs", "server/src/rollout.rs", "server/src/deployment_requests.rs"]})
finally:
    h.stop(process)
    if log:
        log.close()
    assert temp.parent == Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-unassignment-review-")
    shutil.rmtree(temp)
    report["process_stopped"] = process is None or process.poll() is not None
    report["private_fixture_removed"] = not temp.exists()
    report["harness_sha256"] = h.sha(__file__)
    args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
    args.output.resolve().write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ["passed", "server_sha256", "process_stopped", "private_fixture_removed"]}))
