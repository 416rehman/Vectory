"""Disposable real HTTP qualification of reviewed rollback and durable replay."""
import argparse, contextlib, hashlib, http.cookiejar, importlib.util, json, os
from pathlib import Path
import shutil, sqlite3, subprocess, tempfile, time, urllib.request, urllib.error, uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("native_helpers", ROOT / "tests/security/attempt-native.py")
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--server", type=Path, required=True)
parser.add_argument("--expect", choices=["before", "after"], required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
report = {"recorded_at":h.utc(),"scope":"Disposable native server, authenticated HTTP, process restart and private synthetic device/version records. No agent activation or preview access claimed.","server_sha256":h.sha(args.server),"expectation":args.expect,"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-rollback-review-proof-")).resolve()
process = log = None
try:
    binary = temp / "server.exe"; shutil.copyfile(args.server, binary)
    port = h.free_port(); origin = f"http://127.0.0.1:{port}"
    bootstrap = os.urandom(32).hex(); password = os.urandom(32).hex()
    (temp / "bootstrap").write_text(bootstrap)
    env = {k:v for k,v in os.environ.items() if not k.upper().startswith("VECTORY_") and k.upper() not in ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY"]}
    env.update(VECTORY_DATA_DIR=str(temp/"state"),VECTORY_HTTP_ADDR=f"127.0.0.1:{port}",VECTORY_DEVELOPMENT="true",VECTORY_COOKIE_SECURE="false",VECTORY_BOOTSTRAP_SECRET_FILE=str(temp/"bootstrap"),VECTORY_DASHBOARD_DIR=str(temp),VECTORY_RELEASES_DIR=str(temp/"releases"))
    admin = urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    csrf = ""
    def api(path, body=None, method=None, expected=200):
        req = urllib.request.Request(origin+"/api/v1"+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={"Content-Type":"application/json","X-CSRF-Token":csrf})
        try: response=admin.open(req,timeout=15)
        except urllib.error.HTTPError as error: response=error
        with response:
            status=response.status
            try: value=json.load(response)
            except json.JSONDecodeError: value=None
        assert status==expected, f"{req.method} {path}: HTTP {status}, expected {expected}"
        return value
    def start():
        global process, log
        log=(temp/"server.log").open("ab")
        process=subprocess.Popen([str(binary)],cwd=temp,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(150):
            try: api("/status"); return
            except urllib.error.URLError: time.sleep(.1)
        raise AssertionError("Fixture server did not become ready")
    start()
    csrf=api("/bootstrap",{"bootstrap_secret":bootstrap,"name":"Synthetic administrator","email":"admin@example.invalid","password":password})["csrf_token"]
    ids=sorted(str(uuid.uuid4()) for _ in range(2)); a,b,configuration=[str(uuid.uuid4()) for _ in range(3)]
    with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
        for index,id in enumerate(ids):
            data={"id":id,"name":f"rollback-fixture-{index}","last_seen":h.utc(),"vector_version":"0.58.0","reported_generation":0,"apply_state":"unmanaged"}
            db.execute("INSERT INTO devices(id,name,data) VALUES(?,?,?)",(id,data["name"],json.dumps(data)))
        for number,id in enumerate([a,b],1):
            data={"id":id,"configuration_id":configuration,"number":number,"created_at":h.utc(),"artifact":"{}\n","sha256":hashlib.sha256(b"{}\n").hexdigest(),"size":3}
            db.execute("INSERT INTO records(kind,id,data,created_at) VALUES('version',?,?,?)",(id,json.dumps(data),data["created_at"]))
        db.commit()
    def binding(version,priority):
        return {"version_id":version,"selector":{"device_ids":ids,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}}
    api("/deployments",binding(a,10)); source=api("/deployments",binding(b,20)); source_path="/deployments/"+source["id"]
    api("/devices/"+ids[0]+"/revoke",{})
    def snapshot():
        with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
            return {"records":db.execute("SELECT kind,id,data FROM records ORDER BY kind,id").fetchall(),"targets":db.execute("SELECT * FROM deployment_targets ORDER BY deployment_id,device_id").fetchall(),"devices":db.execute("SELECT id,revoked,desired_version_id,desired_generation,assignment_id FROM devices ORDER BY id").fetchall(),"requests":db.execute("SELECT * FROM deployment_requests ORDER BY actor_id,request_id").fetchall()}
    before=snapshot();legacy=api(source_path+"/rollback",{"request_id":str(uuid.uuid4())},expected=400)
    assert snapshot()==before
    report.update(legacy_strict_failure=legacy,legacy_failure_atomic=True)
    if args.expect=="before":
        api(source_path+"/rollback-preview",expected=404)
        report.update(passed=True,preview_unavailable=True,operator_reviewed_mixed_scope_unavailable=True)
    else:
        plan=api(source_path+"/rollback-preview")
        assert plan["ready"] and plan["previous_version_id"]==a
        assert [r["device_id"] for r in plan["eligible_devices"]]==[ids[1]]
        assert plan["excluded_devices"]==[{"device_id":ids[0],"device_name":"rollback-fixture-0","reason":"revoked"}]
        assert snapshot()==before
        request={"request_id":str(uuid.uuid4()),"review_token":plan["review_token"]}
        replacement=api(source_path+"/rollback",request)
        assert replacement["version_id"]==a and [t["device_id"] for t in replacement["targets"]]==[ids[1]]
        assert api(source_path)["targets"]==source["targets"]
        after=snapshot()
        # Deliberately disregard the first receipt for recovery purposes; the
        # same frozen operation is replayed after a full process restart.
        h.stop(process);log.close();log=None;start()
        recovered=api(source_path+"/rollback",request)
        lookup=api("/deployments/requests/"+request["request_id"])
        assert recovered["id"]==replacement["id"]==lookup["deployment"]["id"]
        assert snapshot()==after and len(after["requests"])==1
        api("/devices/"+ids[1]+"/revoke",{})
        revoked=snapshot();assert api(source_path+"/rollback",request)["id"]==replacement["id"] and snapshot()==revoked
        report.update(passed=True,preview=plan,result=replacement,lookup=lookup,review_read_only=True,exact_original_history_preserved=True,exact_live_identity_selected=True,restart_replay_exact_one_operation=True,replay_precedes_new_revocation=True,activation_claimed=False)
finally:
    h.stop(process)
    if log: log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-rollback-review-proof-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None
    report["private_fixture_removed"]=not temp.exists()
    report["harness_sha256"]=h.sha(__file__)
    output=args.output.resolve();output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({k:v for k,v in report.items() if k not in ["preview","result","lookup"]},indent=2))
