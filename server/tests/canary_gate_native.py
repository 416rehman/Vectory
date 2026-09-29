"""Disposable real-HTTP canary historical/current-proof comparison.

Proof metadata is explicitly seeded into a private database, not claimed as
native agent activation. Rust integration tests exercise accepted heartbeats.
"""
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
report = {"recorded_at":h.utc(),"scope":"Disposable native server, SQLite and authenticated HTTP. Synthetic identities and explicitly seeded accepted verification metadata; no native agent/Vector activation claimed.","server_sha256":h.sha(args.server),"expectation":args.expect,"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-current-canary-proof-")).resolve()
process = log = None
try:
    binary=temp/"server.exe";shutil.copyfile(args.server,binary)
    port=h.free_port();origin=f"http://127.0.0.1:{port}"
    bootstrap=os.urandom(32).hex();password=os.urandom(32).hex();(temp/"bootstrap").write_text(bootstrap)
    env={k:v for k,v in os.environ.items() if not k.upper().startswith("VECTORY_") and k.upper() not in ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY"]}
    env.update(VECTORY_DATA_DIR=str(temp/"state"),VECTORY_HTTP_ADDR=f"127.0.0.1:{port}",VECTORY_DEVELOPMENT="true",VECTORY_COOKIE_SECURE="false",VECTORY_BOOTSTRAP_SECRET_FILE=str(temp/"bootstrap"),VECTORY_DASHBOARD_DIR=str(temp),VECTORY_RELEASES_DIR=str(temp/"releases"))
    admin=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));csrf=""
    def api(path,body=None,method=None,expected=200):
        req=urllib.request.Request(origin+"/api/v1"+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={"Content-Type":"application/json","X-CSRF-Token":csrf})
        try:response=admin.open(req,timeout=15)
        except urllib.error.HTTPError as error:response=error
        with response:
            status=response.status;value=json.load(response)
        assert status==expected,f"{req.method} {path}: {status} expected {expected}"
        return value
    def start():
        global process,log
        log=(temp/"server.log").open("ab")
        process=subprocess.Popen([str(binary)],cwd=temp,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(150):
            try:api("/status");return
            except urllib.error.URLError:time.sleep(.1)
        raise AssertionError("Fixture startup timeout")
    start()
    csrf=api("/bootstrap",{"bootstrap_secret":bootstrap,"name":"Synthetic administrator","email":"admin@example.invalid","password":password})["csrf_token"]
    ids=sorted(str(uuid.uuid4()) for _ in range(2));a,b,configuration=[str(uuid.uuid4()) for _ in range(3)]
    artifacts=["{}\n","# distinct immutable template\n{}\n"]
    hashes=[hashlib.sha256(x.encode()).hexdigest() for x in artifacts]
    database=temp/"state/vectory.db"
    with contextlib.closing(sqlite3.connect(database)) as db:
        for index,id in enumerate(ids):
            data={"id":id,"name":f"current-proof-{index}","last_seen":h.utc(),"vector_version":"0.58.0","reported_generation":0,"apply_state":"unmanaged"}
            db.execute("INSERT INTO devices(id,name,data) VALUES(?,?,?)",(id,data["name"],json.dumps(data)))
        for number,id in enumerate([a,b],1):
            data={"id":id,"configuration_id":configuration,"number":number,"created_at":h.utc(),"artifact":artifacts[number-1],"sha256":hashes[number-1],"size":len(artifacts[number-1])}
            db.execute("INSERT INTO records(kind,id,data,created_at) VALUES('version',?,?,?)",(id,json.dumps(data),data["created_at"]))
        db.commit()
    def binding(version,priority,targets,canary):
        return {"version_id":version,"selector":{"device_ids":targets,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":{"kind":"canary" if canary else "all","canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}}
    def accepted(deployment,device,generation,sha):
        with contextlib.closing(sqlite3.connect(database)) as db:
            db.execute("UPDATE devices SET data=json_set(data,'$.last_seen',?,'$.apply_state','verified_applied','$.reported_apply_state','verified_applied','$.reported_generation',?,'$.actual_sha256',?) WHERE id=?",(h.utc(),generation,sha,device))
            db.execute("UPDATE deployment_targets SET state='verified_applied',verified_at=? WHERE deployment_id=? AND device_id=?",(h.utc(),deployment,device));db.commit()
    def age(deployment):
        with contextlib.closing(sqlite3.connect(database)) as db:
            db.execute("UPDATE records SET data=json_set(data,'$.observation_started_at','2020-01-01T00:00:00Z') WHERE kind='deployment' AND id=?",(deployment,));db.commit()
    source=api("/deployments",binding(a,100,ids,True));path="/deployments/"+source["id"]
    accepted(source["id"],ids[0],1,hashes[0]);api(path+"/pause",{})
    replacement=api("/deployments",binding(b,200,[ids[0]],False));accepted(replacement["id"],ids[0],2,hashes[1]);age(source["id"])
    before=api(path);resumed=api(path+"/resume",{})
    next_target=lambda data:next(t for t in data["targets"] if t["device_id"]==ids[1])
    assert next_target(before)["generation"]==0
    current=api("/devices/"+ids[0]);assert current["desired_version_id"]==b and current["reported_generation"]==2 and current["actual_sha256"]==hashes[1]
    report.update(source_before=before,source_after=resumed,current_first_device=current,historical_first_target_retained=next(t for t in resumed["targets"] if t["device_id"]==ids[0])["state"]=="verified_applied",activation_claimed=False)
    if args.expect=="before":
        assert next_target(resumed)["generation"]>0
        report.update(passed=True,expected_defect_reproduced=True,pending_target_admitted_using_superseded_history=True)
    else:
        assert next_target(resumed)["generation"]==0
        summary=api(path+"/summary");targets=api(path+"/targets")
        assert summary["canary_gate"]["state"]=="waiting" and summary["canary_gate"]["reasons"]["superseded"]==1 and summary["verified_count"]==1
        assert api("/openapi.json")==json.loads((ROOT/"contracts/openapi.json").read_text())
        for body in [resumed,summary,targets,api("/deployments"),api("/deployments/history")]:assert "observation_evidence" not in json.dumps(body)
        api("/deployments/"+replacement["id"]+"/unassign",{})
        restored=api("/devices/"+ids[0]);assert restored["desired_version_id"]==a and restored["desired_generation"]==3
        assert api(path+"/summary")["canary_gate"]["state"]=="waiting"
        accepted(source["id"],ids[0],3,hashes[0])
        for _ in range(50):
            observing=api(path+"/summary")
            if observing["canary_gate"]["state"]=="observing":break
            time.sleep(.1)
        assert observing["canary_gate"]["state"]=="observing" and next_target(api(path))["generation"]==0
        age(source["id"])
        for _ in range(50):
            released=api(path)
            if next_target(released)["generation"]>0:break
            time.sleep(.1)
        assert next_target(released)["generation"]>0
        # Separate expected observation: unkeyed group creates cannot recover a
        # lost response across tabs by identity; no membership/runtime effects.
        payload={"name":"Repeated synthetic group","description":"Private expected observation","device_ids":[]}
        first=api("/groups",payload);second=api("/groups",payload)
        assert first["id"]!=second["id"]
        group_report={"recorded_at":h.utc(),"scope":"Separate expected-observation: actual authenticated POST repeated twice; no transport response was deliberately dropped here. Browser evidence exercises response loss.","server_sha256":report["server_sha256"],"first":first,"second":second,"distinct_ids":True,"runtime_membership_empty":True,"passed":True,"activation_claimed":False}
        (ROOT/"docs/evidence/group-create-duplicate-native-observation.json").write_text(json.dumps(group_report,indent=2)+"\n")
        report.update(passed=True,waiting_summary=summary,waiting_targets=targets,restored_observing_summary=observing,after_complete_window=released,strict_current_proof_required=True,historical_proof_preserved=True,restored_generation_requires_fresh_window=True,embedded_openapi_matches_current=True,openapi_sha256=h.sha(ROOT/"contracts/openapi.json"))
finally:
    h.stop(process)
    if log:log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-current-canary-proof-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None;report["private_fixture_removed"]=not temp.exists();report["harness_sha256"]=h.sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True);args.output.resolve().write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({key:report[key] for key in ["passed","expectation","server_sha256","process_stopped","private_fixture_removed"]}))
