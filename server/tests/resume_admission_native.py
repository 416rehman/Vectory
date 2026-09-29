"""Disposable real HTTP qualification of canary resume overlap admission."""
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
report = {"recorded_at":h.utc(),"scope":"Disposable native server and real authenticated HTTP with private synthetic devices/versions and explicitly seeded historical verification. No agent activation or preview access claimed.","server_sha256":h.sha(args.server),"expectation":args.expect,"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-resume-admission-proof-")).resolve()
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
            data={"id":id,"name":f"resume-fixture-{index}","last_seen":h.utc(),"vector_version":"0.58.0","reported_generation":0,"apply_state":"unmanaged"}
            db.execute("INSERT INTO devices(id,name,data) VALUES(?,?,?)",(id,data["name"],json.dumps(data)))
        for number,id in enumerate([a,b],1):
            data={"id":id,"configuration_id":configuration,"number":number,"created_at":h.utc(),"artifact":"{}\n","sha256":hashlib.sha256(b"{}\n").hexdigest(),"size":3}
            db.execute("INSERT INTO records(kind,id,data,created_at) VALUES('version',?,?,?)",(id,json.dumps(data),data["created_at"]))
        db.commit()
    def binding(version,priority,targets):
        return {"version_id":version,"selector":{"device_ids":targets,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":{"kind":"canary","canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}}
    source=api("/deployments",binding(a,100,ids)); source_path="/deployments/"+source["id"]
    api(source_path+"/pause",{})
    competitor=api("/deployments",binding(b,200,[ids[1]])); competitor_path="/deployments/"+competitor["id"]
    direct=api("/deployments/preview",binding(a,300,[ids[1]]))
    assert any(item["code"]=="ACTIVE_CANARY_OVERLAP" for item in direct["blockers"])
    api("/deployments",binding(a,300,[ids[1]]),expected=409)
    with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
        db.execute("UPDATE deployment_targets SET state='verified_applied',verified_at=? WHERE deployment_id=? AND generation>0",(h.utc(),source["id"]))
        data=json.loads(db.execute("SELECT data FROM records WHERE kind='deployment' AND id=?",(source["id"],)).fetchone()[0]);data["observation_started_at"]="2020-01-01T00:00:00Z"
        db.execute("UPDATE records SET data=? WHERE kind='deployment' AND id=?",(json.dumps(data),source["id"]));db.commit()
    def snapshot():
        with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
            return {"records":db.execute("SELECT kind,id,data FROM records ORDER BY kind,id").fetchall(),"targets":db.execute("SELECT * FROM deployment_targets ORDER BY deployment_id,device_id").fetchall(),"devices":db.execute("SELECT id,revoked,desired_version_id,desired_generation,assignment_id,policy_generation FROM devices ORDER BY id").fetchall()}
    original=api(source_path);before=snapshot()
    response=api(source_path+"/resume",{},expected=200 if args.expect=="before" else 409)
    after=snapshot();current=api(source_path);other=api(competitor_path)
    old_target=next(t for t in original["targets"] if t["device_id"]==ids[1]);target=next(t for t in current["targets"] if t["device_id"]==ids[1])
    assert old_target["generation"]==0 and other["status"]=="active"
    desired=api("/devices/"+ids[1]);assert desired["desired_version_id"]==b
    if args.expect=="before":
        assert current["status"]=="active" and target["generation"]>0 and after!=before
        report.update(passed=True,resume_status=200,source_status="active",overlap_generation_before=0,overlap_generation_after=target["generation"],active_competitor_unchanged=True,higher_priority_still_wins=True,verification_seeded=True,activation_claimed=False)
    else:
        assert api("/openapi.json")==json.loads((ROOT/"contracts/openapi.json").read_text())
        report["embedded_openapi_matches_current"]=True
        report["openapi_sha256"]=h.sha(ROOT/"contracts/openapi.json")
        assert response["error"]["code"]=="ACTIVE_CANARY_OVERLAP"
        assert after==before and current["status"]=="paused" and target==old_target
        summary=api(source_path+"/summary");targets=api(source_path+"/targets")
        # Deliberate operator action clears the competing gate; resuming the
        # original then succeeds without silently controlling the competitor.
        api(competitor_path+"/pause",{})
        resumed=api(source_path+"/resume",{})
        assert resumed["status"]=="active" and all(t["generation"]>0 for t in resumed["targets"])
        report.update(passed=True,resume_status=409,error=response,source_summary=summary,source_targets=targets,successful_after_explicit_pause=resumed,all_state_unchanged_on_rejection=True,source_remained_paused=True,target_admission_unchanged=True,explicit_operator_pause_then_resume_success=True,higher_priority_still_wins=True,verification_seeded=True,activation_claimed=False)
finally:
    h.stop(process)
    if log: log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-resume-admission-proof-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None
    report["private_fixture_removed"]=not temp.exists()
    report["harness_sha256"]=h.sha(__file__)
    output=args.output.resolve();output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({k:v for k,v in report.items() if k not in ["source_summary","source_targets","successful_after_explicit_pause"]},indent=2))
