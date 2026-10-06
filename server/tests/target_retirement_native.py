"""Real HTTP persistent-target retirement proof in disposable state."""
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
report = {"recorded_at":h.utc(),"scope":"Disposable native server and authenticated HTTP requests. Synthetic device/version records and one explicitly seeded historical verification; no agent activation claimed. No preview credentials, state or processes accessed.","server_sha256":h.sha(args.server),"expectation":args.expect,"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-target-retirement-proof-")).resolve()
process = log = None
try:
    binary = temp / "server.exe"; shutil.copyfile(args.server, binary)
    port = h.free_port(); origin = f"http://127.0.0.1:{port}"
    bootstrap = os.urandom(32).hex(); password = os.urandom(32).hex()
    (temp / "bootstrap").write_text(bootstrap)
    env = {k:v for k,v in os.environ.items() if not k.upper().startswith("VECTORY_") and k.upper() not in ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY"]}
    env.update(VECTORY_DATA_DIR=str(temp/"state"),VECTORY_HTTP_ADDR=f"127.0.0.1:{port}",VECTORY_DEVELOPMENT="true",VECTORY_COOKIE_SECURE="false",VECTORY_BOOTSTRAP_SECRET_FILE=str(temp/"bootstrap"),VECTORY_DASHBOARD_DIR=str(temp),VECTORY_RELEASES_DIR=str(temp/"releases"))
    log = (temp / "server.log").open("wb")
    process = subprocess.Popen([str(binary)],cwd=temp,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
    def client():
        return urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    admin, operator = client(), client(); csrf = ""
    def api(path, body=None, method=None, expected=200, actor=None, token=None):
        req = urllib.request.Request(origin+"/api/v1"+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={"Content-Type":"application/json","X-CSRF-Token":csrf if token is None else token})
        try: response=(actor or admin).open(req,timeout=15)
        except urllib.error.HTTPError as error: response=error
        with response: status=response.status; value=json.load(response)
        assert status==expected, f"{req.method} {path}: HTTP {status}, expected {expected}"
        return value
    for _ in range(150):
        try: api("/status"); break
        except urllib.error.URLError: time.sleep(.1)
    csrf = api("/bootstrap",{"bootstrap_secret":bootstrap,"name":"Synthetic administrator","email":"admin@example.invalid","password":password})["csrf_token"]
    api("/users",{"name":"Synthetic operator","email":"operator@example.invalid","password":password,"role":"operator","current_password":password})
    op_csrf = api("/login",{"email":"operator@example.invalid","password":password},actor=operator,token="")["csrf_token"]


    ids=sorted(str(uuid.uuid4()) for _ in range(2)); version,configuration=[str(uuid.uuid4()) for _ in range(2)]
    with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
        for index,id in enumerate(ids):
            data={"id":id,"name":f"retirement-fixture-{index}","last_seen":h.utc(),"vector_version":"0.58.0","reported_generation":0,"apply_state":"unmanaged"}
            db.execute("INSERT INTO devices(id,name,data) VALUES(?,?,?)",(id,data["name"],json.dumps(data)))
        data={"id":version,"configuration_id":configuration,"number":1,"created_at":h.utc(),"artifact":"{}\n","sha256":hashlib.sha256(b"{}\n").hexdigest(),"size":3}
        db.execute("INSERT INTO records(kind,id,data,created_at) VALUES('version',?,?,?)",(version,json.dumps(data),data["created_at"]))
        db.commit()
    group=api("/groups",{"name":"Synthetic retirement group","description":"Original","device_ids":ids})
    deployment=api("/deployments",{"version_id":version,"selector":{"device_ids":[],"group_ids":[group["id"]],"exclude_ids":[]},"priority":100,"target_mode":"persistent","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}})
    with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
        db.execute("UPDATE deployment_targets SET state='verified_applied',verified_at='2026-09-26T00:00:00Z' WHERE deployment_id=? AND device_id=?",(deployment["id"],ids[1]));db.commit()
    def target_records():
        with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
            db.row_factory=sqlite3.Row
            return [dict(r) for r in db.execute("SELECT * FROM deployment_targets WHERE deployment_id=? ORDER BY device_id",(deployment["id"],))]
    def delivered_records():
        with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
            return db.execute("SELECT id,data,desired_generation,policy_generation FROM devices ORDER BY id").fetchall()
    before=target_records(); delivered=delivered_records()
    for id in ids: api("/devices/"+id+"/revoke",{})
    after=target_records()
    for _ in range(100):
        summary=api("/deployments/"+deployment["id"]+"/summary")
        if summary["status"]=="completed": break
        time.sleep(.1)
    assert summary["status"]=="completed"
    targets=api("/deployments/"+deployment["id"]+"/targets")
    assert summary["target_count"]==2 and len(targets["items"])==2
    expected=[dict(row,state="removed") for row in before]
    if args.expect=="after":
        assert after==expected and summary["verified_count"]==0 and summary["state_counts"]=={"removed":2}
        assert all(row["state"]=="removed" for row in targets["items"])
    else:
        assert after==before and summary["verified_count"]==1 and summary["state_counts"]=={"desired":1,"verified_applied":1}
    assert delivered_records()==delivered
    for id in ids: api("/devices/"+id+"/revoke",{})
    assert target_records()==after
    proof_fields=["generation","released_at","verified_at","previous_version_id","original","device_id"]
    assert all(all(old[k]==new[k] for k in proof_fields) for old,new in zip(before,after))
    report.update(passed=True,rollout_status=summary["status"],target_count=summary["target_count"],verified_count=summary["verified_count"],state_counts=summary["state_counts"],target_states_before=[r["state"] for r in before],target_states_after=[r["state"] for r in after],historical_verification_seeded=True,historical_identity_generation_and_timestamps_preserved=True,device_delivered_state_and_counters_unchanged=True,repeated_revoke_preserves_target_records=True)

finally:
    h.stop(process)
    if log: log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-target-retirement-proof-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None
    report["private_fixture_removed"]=not temp.exists()
    report["harness_sha256"]=h.sha(__file__)
    output=args.output.resolve();output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report,indent=2))
