"""Real HTTP persistent-membership canary admission proof in disposable state."""
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
report = {"recorded_at":h.utc(),"scope":"Disposable native server and authenticated HTTP requests. Synthetic device/version records; no agent activation claimed. No preview credentials, state or processes accessed.","server_sha256":h.sha(args.server),"expectation":args.expect,"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-group-admission-proof-")).resolve()
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
    api("/users",{"name":"Synthetic operator","email":"operator@example.invalid","password":password,"role":"operator"})
    op_csrf = api("/login",{"email":"operator@example.invalid","password":password},actor=operator,token="")["csrf_token"]

    ids=sorted(str(uuid.uuid4()) for _ in range(3)); first,second,configuration=[str(uuid.uuid4()) for _ in range(3)]
    with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
        for index,id in enumerate(ids):
            data={"id":id,"name":f"admission-fixture-{index}","last_seen":h.utc(),"vector_version":"0.58.0","reported_generation":0,"apply_state":"unmanaged"}
            db.execute("INSERT INTO devices(id,name,data) VALUES(?,?,?)",(id,data["name"],json.dumps(data)))
        for index,id in enumerate([first,second]):
            version={"id":id,"configuration_id":configuration,"number":index+1,"created_at":h.utc(),"artifact":"{}\n","sha256":hashlib.sha256(b"{}\n").hexdigest(),"size":3}
            db.execute("INSERT INTO records(kind,id,data,created_at) VALUES('version',?,?,?)",(id,json.dumps(version),version["created_at"]))
        db.commit()
    group=api("/groups",{"name":"Shared group","description":"Original","device_ids":[ids[1]]})
    rollout={"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}
    incoming=api("/deployments",{"version_id":second,"selector":{"device_ids":[],"group_ids":[group["id"]],"exclude_ids":[]},"priority":200,"target_mode":"persistent","rollout":rollout})
    canary=api("/deployments",{"version_id":first,"selector":{"device_ids":[ids[0],ids[2]],"group_ids":[],"exclude_ids":[]},"priority":100,"target_mode":"snapshot","rollout":dict(rollout,kind="canary")})
    direct={"version_id":second,"selector":{"device_ids":[ids[0]],"group_ids":[],"exclude_ids":[]},"priority":200,"target_mode":"snapshot","rollout":rollout}
    assert api("/deployments/preview",direct)["blockers"][0]["code"]=="ACTIVE_CANARY_OVERLAP"
    assert api("/deployments",direct,expected=409)["error"]["code"]=="CONFLICT"
    def snapshot():
        with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
            return {"records":db.execute("SELECT kind,id,data FROM records ORDER BY kind,id").fetchall(),"devices":db.execute("SELECT id,data,desired_version_id,desired_generation,policy,policy_generation,assignment_id,policy_assignment_id FROM devices ORDER BY id").fetchall(),"targets":db.execute("SELECT * FROM deployment_targets ORDER BY deployment_id,device_id").fetchall()}
    before=api("/devices/"+ids[0]); state_before=snapshot(); assert before["desired_version_id"]==first
    body={"name":group["name"],"description":group["description"],"device_ids":ids[:2],"revision":group["revision"]}
    expected=409 if args.expect=="after" else 200
    result=api("/groups/"+group["id"],body,method="PUT",expected=expected)
    after=api("/devices/"+ids[0]); saved=api("/groups/"+group["id"]); state_after=snapshot()
    assert api("/deployments/"+canary["id"])["status"]=="active"
    unchanged=state_before==state_after
    if args.expect=="after":
        assert result["error"]["code"]=="ACTIVE_CANARY_OVERLAP" and unchanged and saved==group and after==before
        # Only a separate, explicit operator action removes the gate. No automatic action is taken by the edit.
        api("/deployments/"+canary["id"]+"/pause",{})
        admitted=api("/groups/"+group["id"],body,method="PUT")
        assert admitted["revision"]==2 and api("/devices/"+ids[0])["desired_version_id"]==second
        audit=api("/audit/history?action=group.update")["items"][0]
        detail=api("/audit/"+audit["id"])
        assert detail["details"]=={"previous_group_revision":1,"group_revision":2}
    else:
        assert after["desired_version_id"]==second and saved["revision"]==2 and not unchanged
    report.update(passed=True,group_put_status=expected,error_code=result.get("error",{}).get("code"),group_revision_before=group["revision"],group_revision_after=saved["revision"],desired_generation_before=before["desired_generation"],desired_generation_after=after["desired_generation"],assignment_superseded=after["desired_version_id"]==second,all_transactional_state_unchanged=unchanged,active_canary_remained_active=True,direct_create_rejected=True,explicit_pause_then_reviewed_edit_succeeds=args.expect=="after",revision_audit_verified=args.expect=="after")

finally:
    h.stop(process)
    if log: log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-group-admission-proof-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None
    report["private_fixture_removed"]=not temp.exists()
    report["harness_sha256"]=h.sha(__file__)
    output=args.output.resolve();output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report,indent=2))
