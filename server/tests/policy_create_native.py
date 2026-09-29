"""Disposable real-HTTP proof of saved agent-settings template creation response loss.

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
parser.add_argument("--expect",choices=["before","after"],default="before")
args = parser.parse_args()
report = {"recorded_at": h.utc(), "scope": __doc__, "server_sha256": h.sha(args.server), "passed": False,
          "qualification": "Expected-defect observation, not acceptance." if args.expect=="before" else "Keyed template creation and recovery acceptance; no deployment or device activation."}
temp = Path(tempfile.mkdtemp(prefix="vectory-policy-create-")).resolve()
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

    body={"name":"Synthetic ambiguous saved settings","policy":{"heartbeat_seconds":60,"sync_paused":False,"telemetry_enabled":True}}
    key=str(uuid.uuid4())
    if args.expect=="after":
        body["request_id"]=key
        absent=api("/policies/requests/"+key);assert absent=={"create_idempotency":True,"request_id":key,"found":False}
    req=urllib.request.Request(origin+"/api/v1/policies")
    for handler in opener.handlers:
        if isinstance(handler,urllib.request.HTTPCookieProcessor):handler.cookiejar.add_cookie_header(req)
    connection=http.client.HTTPConnection("127.0.0.1",port,timeout=15)
    connection.request("POST","/api/v1/policies",body=json.dumps(body),headers={"Content-Type":"application/json","X-CSRF-Token":csrf,"Cookie":req.get_header("Cookie")})
    first=None
    for _ in range(120):
        with contextlib.closing(sqlite3.connect(database)) as db:
            row=db.execute("SELECT data FROM records WHERE kind='policy'").fetchone()
        if row:first=json.loads(row[0]);break
        time.sleep(.05)
    assert first is not None,"First template was not committed"
    connection.close() # Deliberately never call getresponse(): no status/header/body read.

    if args.expect=="before":
        second=api("/policies",body)
        assert second["id"]!=first["id"] and second["name"]==first["name"] and second["policy"]==first["policy"]
        current=api("/policies")
        with contextlib.closing(sqlite3.connect(database)) as db:
            audits=db.execute("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='policy.create'").fetchone()[0]
            deployments=db.execute("SELECT count(*) FROM records WHERE kind='deployment'").fetchone()[0]
            devices=db.execute("SELECT count(*) FROM devices").fetchone()[0]
        assert len(current)==2 and audits==2 and deployments==devices==0
        report.update(passed=True,classification="expected_defect_observation",correctness_acceptance=False,groups=1,committed_response_never_read=True,identical_explicit_retry=True,first_policy_id=first["id"],second_policy_id=second["id"],saved_records=2,policy_create_audits=2,deployments=0,devices=0,activation_claimed=False,request=body,first_committed_record=first,second_response=second)
    else:
        assert "request_id" not in first and "create_idempotency" not in first
        h.stop(process);log.close();process=log=None
        log=(temp/"server.log").open("ab");process=subprocess.Popen([str(binary)],cwd=temp,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(150):
            try:api("/status");break
            except urllib.error.URLError:time.sleep(.1)
        def snapshot():
            with contextlib.closing(sqlite3.connect(database)) as db:
                return {table:db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()for table in ["records","policy_requests","devices","deployment_targets"]}
        stable=snapshot();found=api("/policies/requests/"+key);replay=api("/policies",body)
        expected=dict(first,request_id=key,create_idempotency=True)
        assert replay==expected and found=={"create_idempotency":True,"request_id":key,"found":True,"policy":expected}
        page=api("/policies/requests");assert page["create_idempotency"] and page["total"]==1 and page["items"][0]["policy_id"]==first["id"] and "policy"not in page["items"][0]
        conflict=api("/policies",dict(body,name="Different saved settings"),expected=409);assert conflict["error"]["code"]=="IDEMPOTENCY_CONFLICT" and snapshot()==stable
        with contextlib.closing(sqlite3.connect(database)) as db:
            audits=db.execute("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='policy.create'").fetchone()[0]
            deployments=db.execute("SELECT count(*) FROM records WHERE kind='deployment'").fetchone()[0]
            devices=db.execute("SELECT count(*) FROM devices").fetchone()[0]
            assert audits==1 and deployments==devices==0
            db.execute("DELETE FROM records WHERE kind='policy' AND id=?",(first["id"],));db.commit()
        stable=snapshot();missing=api("/policies/requests/"+key,expected=409);api("/policies",body,expected=409);assert snapshot()==stable
        unavailable=api("/policies/requests");assert unavailable["items"][0]["policy_name"]is None and unavailable["items"][0]["policy_id"]==first["id"]
        directory=ROOT/".local/agent-settings-native-bodies";directory.mkdir(parents=True,exist_ok=True);manifest=[]
        for name,value,schema in [("native_absent",absent,"PolicyRequestLookup"),("native_receipt",replay,"PolicyCreateReceipt"),("native_lookup",found,"PolicyRequestLookup"),("native_history",page,"PolicyRequestPage"),("native_conflict",conflict,"Error"),("native_missing",missing,"Error"),("native_missing_history",unavailable,"PolicyRequestPage")]:
            file=name+".json";(directory/file).write_text(json.dumps(value,indent=2)+"\n");manifest.append({"file":file,"schema":schema})
        (directory/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
        assert api("/openapi.json")==json.loads((ROOT/"contracts/openapi.json").read_text())
        report.update(passed=True,classification="native_correctness_acceptance",correctness_acceptance=True,groups=3,groups_description=["Unread committed template response survives real restart, exact actor lookup and identical retry with one result/audit","Changed same-key payload conflicts without writes; actor recent metadata discovers only committed result","Deleted mapped template remains a tombstone; lookup/retry conflict and never recreate"],committed_response_never_read=True,restarted_same_datastore=True,saved_policy_id=first["id"],request_id=key,policy_create_audits=1,devices=0,deployments=0,activation_claimed=False,request_metadata_not_persisted=True,replay_read_only=True,missing_original_not_recreated=True,embedded_openapi_matches_current=True,body_manifest=str(directory.relative_to(ROOT)/"manifest.json"))
    report['source_sha256']={p:h.sha(ROOT/p)for p in ["server/src/api.rs","server/src/db.rs","server/src/auth.rs"]+(["server/src/policy_requests.rs","server/migrations/0020_policy_requests.sql","server/src/lib.rs"]if args.expect=="after"else[])}

finally:
    h.stop(process)
    if log:log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-policy-create-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll()is not None
    report["private_fixture_removed"]=not temp.exists()
    report["harness_sha256"]=h.sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({key:report[key]for key in ["passed","server_sha256","process_stopped","private_fixture_removed"]}))
