"""Disposable real-HTTP group-create durable recovery comparison.

Uses only synthetic accounts/devices in a private database. No native agent
activation or production access is claimed.
"""
import argparse, contextlib, hashlib, http.cookiejar, http.client, importlib.util, json, os
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
report = {"recorded_at":h.utc(),"scope":"Disposable native server, SQLite and authenticated HTTP. Synthetic accounts and devices; actual unread HTTP response, durable restart lookup and exact keyed replay. No agent activation claimed.","server_sha256":h.sha(args.server),"expectation":args.expect,"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-group-create-recovery-")).resolve()
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
    database=temp/"state/vectory.db";key=str(uuid.uuid4());device=str(uuid.uuid4())
    with contextlib.closing(sqlite3.connect(database)) as db:
        data={"id":device,"name":"Recovery fixture","vector_version":"0.58.0","last_seen":h.utc(),"apply_state":"unmanaged","reported_generation":0}
        db.execute("INSERT INTO devices(id,name,data) VALUES(?,?,?)",(device,data["name"],json.dumps(data)));db.commit()
    payload={"request_id":key,"name":"Synthetic creation","description":"Frozen original request","device_ids":[device]}
    preflight=api("/groups/requests/"+key,expected=404 if args.expect=="before" else 200)
    if args.expect=="after":assert preflight=={"request_id":key,"found":False}
    # Send the complete request but never read any HTTP response bytes. Observe
    # commit only through the private fixture DB, then close this client socket.
    request=urllib.request.Request(origin+"/api/v1/groups")
    for handler in admin.handlers:
        if isinstance(handler,urllib.request.HTTPCookieProcessor):handler.cookiejar.add_cookie_header(request)
    connection=http.client.HTTPConnection("127.0.0.1",port,timeout=15)
    connection.request("POST","/api/v1/groups",body=json.dumps(payload),headers={"Content-Type":"application/json","X-CSRF-Token":csrf,"Cookie":request.get_header("Cookie")})
    committed=None
    for _ in range(100):
        with contextlib.closing(sqlite3.connect(database)) as db:
            row=db.execute("SELECT id FROM records WHERE kind='group'").fetchone()
        if row:committed=row[0];break
        time.sleep(.05)
    assert committed;connection.close()
    report["response_body_never_read"]=True
    if args.expect=="before":
        repeated=api("/groups",payload)
        assert repeated["id"]!=committed and "request_id" not in repeated
        report.update(passed=True,lookup_status=404,duplicate_group_created=True,first_group_id=committed,repeated_group_id=repeated["id"])
    else:
        assert api("/openapi.json")==json.loads((ROOT/"contracts/openapi.json").read_text())
        lookup=api("/groups/requests/"+key);assert lookup["found"] and lookup["group"]["id"]==committed and lookup["group"]["request_id"]==key
        # Editing and device retirement must not reapply the frozen old members.
        edited=api("/groups/"+committed,{"revision":lookup["group"]["revision"],"name":"Edited recovered result","description":"Later edit","device_ids":[]},method="PUT")
        api("/devices/"+device+"/revoke",{})
        h.stop(process);log.close();process=None;log=None;start()
        restored=api("/groups/requests/"+key);replayed=api("/groups",payload)
        assert restored["group"]["id"]==committed and replayed==restored["group"] and replayed["revision"]==edited["revision"] and replayed["device_ids"]==[] and replayed["name"]==edited["name"]
        conflict=api("/groups",dict(payload,name="Changed original payload"),expected=409);assert conflict["error"]["code"]=="IDEMPOTENCY_CONFLICT"
        history=api("/groups/requests");assert history["total"]==1 and history["items"][0]["group_id"]==committed
        with contextlib.closing(sqlite3.connect(database)) as db:
            groups=db.execute("SELECT count(*) FROM records WHERE kind='group'").fetchone()[0]
            mappings=db.execute("SELECT count(*) FROM group_requests").fetchone()[0]
            audits=db.execute("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='group.create'").fetchone()[0]
        assert groups==mappings==audits==1
        report.update(passed=True,lookup_before_restart=lookup,lookup_after_restart=restored,replayed_current_group=replayed,request_history=history,conflict=conflict,group_count=groups,registry_count=mappings,creation_audit_count=audits,edited_membership_preserved=True,revoked_original_member_did_not_block_recovery=True,embedded_openapi_matches_current=True,openapi_sha256=h.sha(ROOT/"contracts/openapi.json"))
        bodies=ROOT/".local/group-create-recovery-native-bodies";bodies.mkdir(parents=True,exist_ok=True)
        for name,value in {"native_preflight":preflight,"native_lookup_before_restart":lookup,"native_lookup_after_restart":restored,"native_replayed":replayed,"native_history":history,"native_conflict":conflict}.items():
            (bodies/(name+".json")).write_text(json.dumps(value,indent=2)+"\n")
finally:
    h.stop(process)
    if log:log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-group-create-recovery-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None;report["private_fixture_removed"]=not temp.exists();report["harness_sha256"]=h.sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True);args.output.resolve().write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({key:report[key] for key in ["passed","expectation","server_sha256","process_stopped","private_fixture_removed"]}))
