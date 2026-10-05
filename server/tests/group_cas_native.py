"""Real HTTP group lost-update proof in disposable state; no preview access."""
import argparse, contextlib, http.cookiejar, importlib.util, json, os
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
report = {"recorded_at":h.utc(),"scope":"Disposable native server, two real authenticated HTTP clients and persistent policy. Two synthetic device rows; no agent activation claimed. No preview credentials, state or processes accessed.","server_sha256":h.sha(args.server),"expectation":args.expect,"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-group-cas-proof-")).resolve()
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
    ids=[str(uuid.uuid4()),str(uuid.uuid4())]
    with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
        for index,id in enumerate(ids):
            data={"id":id,"name":f"group-fixture-{index}","last_seen":h.utc(),"vector_version":"0.58.0","reported_generation":0,"apply_state":"unmanaged"}
            db.execute("INSERT INTO devices(id,name,data) VALUES(?,?,?)",(id,data["name"],json.dumps(data)))
        db.commit()
    group=api("/groups",{"name":"Shared group","description":"Original","device_ids":ids[:1]})
    stale=next(g for g in api("/groups",actor=operator,token=op_csrf) if g["id"]==group["id"])
    binding=api("/deployments",{"policy":{"heartbeat_seconds":180,"sync_paused":False,"telemetry_enabled":True},"selector":{"device_ids":[],"group_ids":[group["id"]],"exclude_ids":[]},"priority":100,"target_mode":"persistent","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}})
    def edit(snapshot,members,description):
        body={"name":snapshot["name"],"description":description,"device_ids":members}
        if "revision" in snapshot: body["revision"]=snapshot["revision"]
        return body
    url="/groups/"+group["id"]
    updated=api(url,edit(group,ids,"Original"),method="PUT")
    device_url="/devices/"+ids[1]
    before=api(device_url)
    assert before["policy_assignment"]["id"]==binding["id"]
    with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
        generation_before=db.execute("SELECT policy_generation FROM devices WHERE id=?",(ids[1],)).fetchone()[0]
    expected=409 if args.expect=="after" else 200
    result=api(url,edit(stale,ids[:1],"Only a description edit from older tab"),method="PUT",expected=expected,actor=operator,token=op_csrf)
    after=api(device_url)
    saved=next(g for g in api("/groups") if g["id"]==group["id"])
    with contextlib.closing(sqlite3.connect(temp/"state/vectory.db")) as db:
        generation_after=db.execute("SELECT policy_generation FROM devices WHERE id=?",(ids[1],)).fetchone()[0]
    retained=ids[1] in saved["device_ids"] and after.get("policy_assignment",{}).get("id")==binding["id"]
    if args.expect=="after":
        assert result["error"]["code"]=="STALE_REVISION" and retained and saved==updated and after==before
        assert generation_after==generation_before and saved["revision"]==2
        assert api(url)==saved
        missing=edit(saved,ids,"No review token");missing.pop("revision")
        assert api(url,missing,method="PUT",expected=400)["error"]["code"]=="INVALID_INPUT"
    else:
        assert not retained and after["effective_policy"]["heartbeat_seconds"]==60 and generation_after==generation_before+1
    report.update(passed=True,stale_http_status=expected,stale_error_code=result.get("error",{}).get("code"),group_revision_before=group.get("revision"),group_revision_after=saved.get("revision"),new_member_retained=retained,policy_generation_before=generation_before,policy_generation_after=generation_after,effective_heartbeat_before=before["effective_policy"]["heartbeat_seconds"],effective_heartbeat_after=after["effective_policy"]["heartbeat_seconds"])
finally:
    h.stop(process)
    if log: log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-group-cas-proof-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None
    report["private_fixture_removed"]=not temp.exists()
    report["harness_sha256"]=h.sha(__file__)
    output=args.output.resolve();output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report,indent=2))
