"""Disposable real-HTTP keyed pipeline creation and duplication recovery after unread responses.

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

parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
report = {"recorded_at":h.utc(),"scope":"Disposable native server, SQLite and authenticated HTTP. Synthetic account and configurations; two actual unread committed HTTP responses followed by draft edits, archive, restart and exact keyed retries. No agent activation claimed.","server_sha256":h.sha(args.server),"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-pipeline-create-recovery-")).resolve()
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
    database=temp/"state/vectory.db"
    pipeline={"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}}
    def unread_commit(path,payload,name):
        request=urllib.request.Request(origin+"/api/v1"+path)
        for handler in admin.handlers:
            if isinstance(handler,urllib.request.HTTPCookieProcessor):handler.cookiejar.add_cookie_header(request)
        connection=http.client.HTTPConnection("127.0.0.1",port,timeout=15)
        connection.request("POST","/api/v1"+path,body=json.dumps(payload),headers={"Content-Type":"application/json","X-CSRF-Token":csrf,"Cookie":request.get_header("Cookie")})
        result=None
        for _ in range(100):
            with contextlib.closing(sqlite3.connect(database)) as db:
                rows=db.execute("SELECT data FROM records WHERE kind='configuration' AND json_extract(data,'$.name')=?",(name,)).fetchall()
            if rows:assert len(rows)==1;result=json.loads(rows[0][0]);break
            time.sleep(.05)
        assert result
        connection.close()
        return result
    assert api("/openapi.json")==json.loads((ROOT/"contracts/openapi.json").read_text())
    key=str(uuid.uuid4());copy_key=str(uuid.uuid4())
    preflight=api("/configurations/requests/"+key);assert preflight=={"request_id":key,"found":False}
    payload={"request_id":key,"name":"Synthetic creation response loss","description":"Private fixture","config":pipeline,"graph":{"nodes":[],"edges":[]}}
    first=unread_commit("/configurations",payload,payload["name"])
    duplicate_payload={"request_id":copy_key,"revision":1,"name":"Synthetic clone response loss","description":"Private copy"}
    duplicate_path="/configurations/"+first["id"]+"/duplicate"
    clone=unread_commit(duplicate_path,duplicate_payload,duplicate_payload["name"])
    def edit_archive(c,name):
        draft=api("/configurations/"+c["id"]+"/draft",{"revision":c["revision"],"name":name,"description":"Later result metadata","config":{"sources":{},"sinks":{},"new_unknown":{"retain":True}},"graph":{"nodes":[],"edges":[]}},method="PUT")
        return api("/configurations/"+c["id"]+"/archive",{"revision":draft["revision"]})
    current=edit_archive(first,"Edited created pipeline")
    current_clone=edit_archive(clone,"Edited cloned pipeline")
    h.stop(process);log.close();process=None;log=None;start()
    found_create=api("/configurations/requests/"+key)
    found_copy=api("/configurations/requests/"+copy_key)
    replay_create=api("/configurations",payload)
    replay_copy=api(duplicate_path,duplicate_payload)
    assert replay_create==dict(current,request_id=key) and replay_copy==dict(current_clone,request_id=copy_key)
    assert found_create=={"request_id":key,"found":True,"operation":"create","source_configuration_id":None,"source_revision":None,"configuration":replay_create}
    assert found_copy=={"request_id":copy_key,"found":True,"operation":"duplicate","source_configuration_id":first["id"],"source_revision":1,"configuration":replay_copy}
    conflict=api("/configurations",dict(payload,name="Different supplied request"),expected=409);assert conflict["error"]["code"]=="IDEMPOTENCY_CONFLICT"
    cross_operation=api(duplicate_path,dict(duplicate_payload,request_id=key),expected=409);assert cross_operation["error"]["code"]=="IDEMPOTENCY_CONFLICT"
    history=api("/configurations/requests");assert history["total"]==2
    assert api("/configurations/"+first["id"])==current and api("/configurations/"+clone["id"])==current_clone
    with contextlib.closing(sqlite3.connect(database)) as db:
        counts={kind:db.execute("SELECT count(*) FROM records WHERE kind=?",(kind,)).fetchone()[0] for kind in ["configuration","revision","version","deployment"]}
        audits={action:db.execute("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')=?",(action,)).fetchone()[0] for action in ["configuration.create","configuration.duplicate"]}
        mappings=db.execute("SELECT count(*) FROM pipeline_requests").fetchone()[0]
    assert counts=={"configuration":2,"revision":6,"version":0,"deployment":0} and audits=={"configuration.create":1,"configuration.duplicate":1} and mappings==2
    # Future deletion/restore corruption is modeled only in this disposable DB;
    # no product deletion route exists. Duplicate replay cannot require its source.
    with contextlib.closing(sqlite3.connect(database)) as db:
        db.execute("DELETE FROM records WHERE kind='configuration' AND id=?",(first["id"],));db.commit()
    missing_source_replay=api(duplicate_path,duplicate_payload);assert missing_source_replay==replay_copy
    unavailable=api("/configurations/requests/"+key,expected=409);assert unavailable["error"]["code"]=="CONFLICT"
    unavailable_replay=api("/configurations",payload,expected=409);assert unavailable_replay["error"]["code"]=="CONFLICT"
    after_removal=api("/configurations/requests");assert after_removal["total"]==2
    with contextlib.closing(sqlite3.connect(database)) as db:
        assert db.execute("SELECT count(*) FROM records WHERE kind='configuration'").fetchone()[0]==1 and db.execute("SELECT count(*) FROM pipeline_requests").fetchone()[0]==2
    report.update(passed=True,response_bytes_never_read_for_both=True,create_lookup_after_restart=found_create,duplicate_lookup_after_restart=found_copy,replayed_current_create=replay_create,replayed_current_clone=replay_copy,original_request_source_revision=1,current_source_revision=current["revision"],record_counts_before_fixture_removal=counts,creation_audit_counts=audits,request_mapping_count=mappings,current_edits_and_archive_preserved=True,duplicate_replay_after_fixture_source_removal=missing_source_replay,missing_result_error=unavailable,tombstone_never_recreated=True,request_history=history,history_after_fixture_removal=after_removal,body_conflict=conflict,operation_conflict=cross_operation,no_devices_or_deployments=True,activation_claimed=False,embedded_openapi_matches_current=True,openapi_sha256=h.sha(ROOT/"contracts/openapi.json"))
    bodies=ROOT/".local/pipeline-creation-recovery-native-bodies";bodies.mkdir(parents=True,exist_ok=True)
    for name,value in {"native_absent_lookup":preflight,"native_create_lookup":found_create,"native_duplicate_lookup":found_copy,"native_create_receipt":replay_create,"native_duplicate_receipt":replay_copy,"native_discovery_history":history,"native_removed_history":after_removal,"native_missing_result_error":unavailable,"native_body_conflict_error":conflict,"native_operation_conflict_error":cross_operation}.items():
        (bodies/(name+".json")).write_text(json.dumps(value,indent=2)+"\n")

finally:
    h.stop(process)
    if log:log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-pipeline-create-recovery-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None;report["private_fixture_removed"]=not temp.exists();report["harness_sha256"]=h.sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True);args.output.resolve().write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({key:report[key] for key in ["passed","server_sha256","process_stopped","private_fixture_removed"]}))
