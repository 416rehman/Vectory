"""Disposable real-HTTP proof of reviewed scheduled-device snapshot refresh.

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
args = parser.parse_args()
report = {"recorded_at": h.utc(), "scope": __doc__, "server_sha256": h.sha(args.server), "passed": False,
          "qualification": "Native HTTP reviewed refresh and unread-response/restart recovery qualification."}
temp = Path(tempfile.mkdtemp(prefix="vectory-scheduled-refresh-")).resolve()
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


    import datetime
    def schedule(group_id):
        return api("/deployments", {"selector":{"device_ids":[],"group_ids":[group_id],"exclude_ids":[]},"policy":{"heartbeat_seconds":60,"sync_paused":False,"telemetry_enabled":True},"priority":100,"target_mode":"snapshot","scheduled_at":(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).isoformat(),"rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0}})
    def edit_group(group,selected):
        return api("/groups/"+group["id"],{"name":group["name"],"description":"","device_ids":selected,"revision":group["revision"]},method="PUT")
    def request(preview):
        return {"review_token":preview["review_token"],"expected_device_ids":[d["id"]for d in preview["devices"]]}
    def snapshot():
        with contextlib.closing(sqlite3.connect(database)) as db:
            return {table:db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()for table in ["records","devices","deployment_targets"]}
    def saved_ids(preview):
        return {d["id"]for d in preview["saved_devices"]}
    def audit_count():
        with contextlib.closing(sqlite3.connect(database)) as db:
            return db.execute("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.refresh_targets'").fetchone()[0]
    def counters():
        with contextlib.closing(sqlite3.connect(database)) as db:
            return db.execute("SELECT id,desired_generation,policy_generation,json_extract(data,'$.reported_generation') FROM devices ORDER BY id").fetchall()
    original_counters=counters()
    group=api("/groups",{"name":"Synthetic schedule group","description":"","device_ids":devices[:1]})
    source=schedule(group["id"]);path="/deployments/"+source["id"]
    group=edit_group(group,devices[:2]);review_a=api(path+"/refresh-preview",{})
    group=edit_group(group,[devices[0],devices[2]]);review_b=api(path+"/refresh-preview",{});receipt_b=api(path+"/refresh",request(review_b))
    group=edit_group(group,devices[:2]);stable=snapshot();error=api(path+"/refresh",request(review_a),expected=409)
    assert error["error"]["code"]=="SCHEDULE_REFRESH_REVIEW_CHANGED" and snapshot()==stable
    assert saved_ids(api(path+"/refresh-preview",{}))=={devices[0],devices[2]} and audit_count()==1
    fresh=api(path+"/refresh-preview",{});assert fresh["ready"]
    # A real POST commits while no response status, header or body is read.
    req=urllib.request.Request(origin+"/api/v1"+path)
    for handler in opener.handlers:
        if isinstance(handler,urllib.request.HTTPCookieProcessor):handler.cookiejar.add_cookie_header(req)
    connection=http.client.HTTPConnection("127.0.0.1",port,timeout=15)
    connection.request("POST","/api/v1"+path+"/refresh",body=json.dumps(request(fresh)),headers={"Content-Type":"application/json","X-CSRF-Token":csrf,"Cookie":req.get_header("Cookie")})
    for _ in range(120):
        if audit_count()==2:break
        time.sleep(.05)
    else:raise AssertionError("Reviewed refresh did not commit")
    connection.close();h.stop(process);log.close();process=log=None
    log=(temp/"server.log").open("ab");process=subprocess.Popen([str(binary)],cwd=temp,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(150):
        try:api("/status");break
        except urllib.error.URLError:time.sleep(.1)
    current=api(path+"/refresh-preview",{})
    assert current["source_deployment_id"]==source["id"] and current["source_status"]=="scheduled"
    assert saved_ids(current)==set(devices[:2]) and current["review_token"]!=fresh["review_token"]
    stable=snapshot();api(path+"/refresh",request(fresh),expected=409);assert snapshot()==stable
    noop=api(path+"/refresh",request(current));assert snapshot()==stable and audit_count()==2
    assert all(t["state"]=="pending" and t["generation"]==0 for t in noop["targets"])
    assert "target_refresh_revision" not in noop and counters()==original_counters
    api(path+"/cancel",{});inactive=api(path+"/refresh-preview",{})
    assert inactive["source_status"]=="cancelled" and not inactive["ready"] and inactive["devices"]==[] and saved_ids(inactive)==set(devices[:2])
    bodies={"native_ready_preview":(fresh,"ScheduledRefreshPreview"),"native_stale_error":(error,"Error"),"native_changed_receipt":(receipt_b,"Deployment"),"native_current_preview":(current,"ScheduledRefreshPreview"),"native_noop_receipt":(noop,"Deployment"),"native_inactive_preview":(inactive,"ScheduledRefreshPreview")}
    directory=ROOT/".local/scheduled-refresh-native-bodies";directory.mkdir(parents=True,exist_ok=True);manifest=[]
    for name,(value,schema)in bodies.items():
        file=name+".json";(directory/file).write_text(json.dumps(value,indent=2)+"\n");manifest.append({"file":file,"schema":schema})
    (directory/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    assert api("/openapi.json")==json.loads((ROOT/"contracts/openapi.json").read_text())
    report.update(passed=True,groups=3,groups_description=["Late reviewed request rejected without overwriting newer saved selection","Committed response wholly unread, restart, exact current selection read, old-token rejection and fresh no-op","Inactive schedule preserves saved selection and blocks proposal"],committed_response_never_read=True,restart_current_selection_observed=True,request_attribution_claimed=False,refresh_audit_count=2,no_op_changed_nothing=True,device_counters_unchanged=True,activation_claimed=False,embedded_openapi_matches_current=True,body_manifest=str(directory.relative_to(ROOT)/"manifest.json"),source_sha256={p:h.sha(ROOT/p)for p in ["server/src/api.rs","server/src/rollout.rs","server/src/scheduled_refresh.rs","server/src/lib.rs"]})
finally:
    h.stop(process)
    if log:log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-scheduled-refresh-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll()is not None
    report["private_fixture_removed"]=not temp.exists()
    report["harness_sha256"]=h.sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({key:report[key]for key in ["passed","server_sha256","process_stopped","private_fixture_removed"]}))
