"""Private HTTP proof of deployment request correlation and current-result recovery.

The two mutation responses are deliberately never read. Mapping IDs are observed
only in this disposable SQLite fixture, then recovered after retirement and restart.
No agent, actual fleet activation, preview or release environment is used.
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
report = {"recorded_at":h.utc(), "scope":__doc__, "expect":args.expect,
          "server_sha256":h.sha(args.server), "passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-deployment-correlation-")).resolve()
process = log = None
try:
    binary=temp/"server.exe"; shutil.copyfile(args.server,binary)
    port=h.free_port(); origin=f"http://127.0.0.1:{port}"
    bootstrap=os.urandom(32).hex(); password=os.urandom(32).hex(); (temp/"bootstrap").write_text(bootstrap)
    env={k:v for k,v in os.environ.items() if not k.upper().startswith("VECTORY_") and k.upper() not in ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY"]}
    env.update(VECTORY_DATA_DIR=str(temp/"state"),VECTORY_HTTP_ADDR=f"127.0.0.1:{port}",VECTORY_DEVELOPMENT="true",VECTORY_COOKIE_SECURE="false",VECTORY_BOOTSTRAP_SECRET_FILE=str(temp/"bootstrap"),VECTORY_DASHBOARD_DIR=str(temp),VECTORY_RELEASES_DIR=str(temp/"releases"))
    admin=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())); csrf=""
    def api(path,body=None,method=None,expected=200,opener=None,token=None):
        req=urllib.request.Request(origin+"/api/v1"+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={"Content-Type":"application/json","X-CSRF-Token":csrf if token is None else token})
        try: response=(opener or admin).open(req,timeout=15)
        except urllib.error.HTTPError as error: response=error
        with response: status=response.status; value=json.load(response)
        assert status==expected,f"{req.method} {path}: {status}, expected {expected}"
        return value
    def start():
        global process,log
        log=(temp/"server.log").open("ab")
        process=subprocess.Popen([str(binary)],cwd=temp,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(150):
            try: api("/status"); return
            except urllib.error.URLError: time.sleep(.1)
        raise AssertionError("Fixture startup timeout")
    start()
    csrf=api("/bootstrap",{"bootstrap_secret":bootstrap,"name":"Synthetic administrator","email":"admin@example.invalid","password":password})["csrf_token"]
    database=temp/"state/vectory.db"
    devices=[str(uuid.uuid4()) for _ in range(2)]; versions=[str(uuid.uuid4()) for _ in range(2)]
    config_id=str(uuid.uuid4()); now=h.utc()
    with contextlib.closing(sqlite3.connect(database)) as db:
        for index,device in enumerate(devices):
            data={"id":device,"name":f"Synthetic target {index}","os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"synthetic","last_seen":now,"apply_state":"unmanaged","reported_generation":0,"created_at":now}
            db.execute("INSERT INTO devices(id,name,data) VALUES(?,?,?)",(device,data["name"],json.dumps(data)))
        for index,version in enumerate(versions):
            data={"id":version,"configuration_id":config_id,"number":index+1,"artifact":"{}\n","sha256":hashlib.sha256(b"{}\n").hexdigest(),"size":3,"created_at":now}
            db.execute("INSERT INTO records(kind,id,data,created_at) VALUES('version',?,?,?)",(version,json.dumps(data),now))
        db.commit()
    def request(device,priority,version=None,key=None,persistent=False):
        payload={"selector":{"device_ids":[device],"group_ids":[],"exclude_ids":[]},"expected_device_ids":[device],"priority":priority,"target_mode":"persistent" if persistent else "snapshot","scheduled_at":None,"rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0}}
        if version: payload["version_id"]=version
        else: payload["policy"]={"heartbeat_seconds":60,"sync_paused":False,"telemetry_enabled":True}
        if key: payload["request_id"]=key
        return payload
    def unread_commit(path,payload):
        req=urllib.request.Request(origin+"/api/v1"+path)
        for handler in admin.handlers:
            if isinstance(handler,urllib.request.HTTPCookieProcessor): handler.cookiejar.add_cookie_header(req)
        connection=http.client.HTTPConnection("127.0.0.1",port,timeout=15)
        connection.request("POST","/api/v1"+path,body=json.dumps(payload),headers={"Content-Type":"application/json","X-CSRF-Token":csrf,"Cookie":req.get_header("Cookie")})
        result=None
        for _ in range(120):
            with contextlib.closing(sqlite3.connect(database)) as db:
                rows=db.execute("SELECT deployment_id FROM deployment_requests WHERE request_id=?",(payload["request_id"],)).fetchall()
            if rows: assert len(rows)==1; result=rows[0][0]; break
            time.sleep(.05)
        connection.close()  # Never getresponse/read: even the response status is discarded.
        assert result,"Keyed fixture mutation did not commit"
        return result
    keys=[str(uuid.uuid4()) for _ in range(2)]
    absent=api("/deployments/requests/"+keys[0])
    create_payload=request(devices[0],100,key=keys[0],persistent=True)
    preview=api("/deployments/preview",create_payload)
    created_id=unread_commit("/deployments",create_payload)
    api("/deployments",request(devices[1],10,versions[0]))
    source=api("/deployments",request(devices[1],20,versions[1]))
    review=api("/deployments/"+source["id"]+"/rollback-preview"); assert review["ready"]
    rollback_payload={"request_id":keys[1],"review_token":review["review_token"]}
    rollback_path="/deployments/"+source["id"]+"/rollback"
    rollback_id=unread_commit(rollback_path,rollback_payload)
    assert rollback_id!=source["id"]
    api("/devices/"+devices[0]+"/revoke",{})
    api("/deployments/"+created_id+"/cancel",{})
    api("/deployments/"+rollback_id+"/cancel",{})
    other_password=os.urandom(32).hex()
    api("/users",{"name":"Other synthetic operator","email":"other@example.invalid","password":other_password,"role":"operator"})
    other=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    other_csrf=api("/login",{"email":"other@example.invalid","password":other_password},opener=other,token="")["csrf_token"]
    def snapshot():
        with contextlib.closing(sqlite3.connect(database)) as db:
            return {table:db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall() for table in ["records","devices","deployment_targets","deployment_requests"]}
    h.stop(process); log.close(); process=None; log=None; start()
    before=snapshot()
    expected=[{"request_id":keys[0],"operation":"create","source_deployment_id":None,"result_id":created_id},
              {"request_id":keys[1],"operation":"rollback","source_deployment_id":source["id"],"result_id":rollback_id}]
    rows=[]; bodies={}; manifest=[]
    def emit(name,schema,value,correlation=None):
        bodies[name]=value
        manifest.append({"file":name+".json","schema":schema,"expected":correlation})
    for index,(path,payload) in enumerate([("/deployments",create_payload),(rollback_path,rollback_payload)]):
        identity=expected[index]; kind=identity["operation"]
        found=api("/deployments/requests/"+keys[index].upper()); replay=api(path,payload)
        assert found["found"] and replay["id"]==identity["result_id"] and found["deployment"]==replay
        assert replay["status"]=="cancelled"
        if index==0: assert replay["targets"][0]["state"]=="removed"
        if args.expect=="after":
            for field in ["request_id","operation","source_deployment_id"]:
                assert replay[field]==identity[field] and found[field]==identity[field]
            assert replay["request_correlation"] is True
        else:
            assert all(field not in replay and field not in found for field in ["request_id","operation","source_deployment_id"])
        rows.append({"expected":identity,"receipt":replay,"lookup":found})
        emit("native_"+kind+"_receipt","DeploymentReceipt",replay,identity)
        emit("native_"+kind+"_lookup","DeploymentRequestStatus",found,identity)
        emit("native_"+kind+"_summary","DeploymentSummary",api("/deployments/"+identity["result_id"]+"/summary"))
    other_lookup=api("/deployments/requests/"+keys[0],opener=other,token=other_csrf)
    assert other_lookup==({"request_id":keys[0],"found":False} if args.expect=="after" else {"found":False})
    conflict=api("/deployments",dict(create_payload,priority=101),expected=409)
    assert conflict["error"]["code"]=="IDEMPOTENCY_CONFLICT"
    assert snapshot()==before,"Reads/replays or rejected mismatch mutated the fixture"
    with contextlib.closing(sqlite3.connect(database)) as db:
        audits={action:db.execute("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')=?",(action,)).fetchone()[0] for action in ["deployment.create","deployment.rollback"]}
        mappings=db.execute("SELECT count(*) FROM deployment_requests").fetchone()[0]
        stored=[json.loads(row[0]) for row in db.execute("SELECT data FROM records WHERE kind='deployment'")]
    assert mappings==2 and audits=={"deployment.create":4,"deployment.rollback":1}
    assert all(not any(field in value for field in ["request_id","operation","source_deployment_id","request_correlation"]) for value in stored)
    if args.expect=="after":
        assert absent=={"request_id":keys[0],"found":False} and preview["request_correlation"] is True
        assert api("/openapi.json")==json.loads((ROOT/"contracts/openapi.json").read_text())
        emit("native_absent_lookup","DeploymentRequestStatus",absent,{"request_id":keys[0],"found":False})
        emit("native_other_actor_lookup","DeploymentRequestStatus",other_lookup,{"request_id":keys[0],"found":False})
        emit("native_preview","Preview",preview)
        emit("native_body_conflict_error","Error",conflict)
        directory=ROOT/".local/deployment-correlation-native-bodies"; directory.mkdir(parents=True,exist_ok=True)
        for name,value in bodies.items(): (directory/(name+".json")).write_text(json.dumps(value,indent=2)+"\n")
        (directory/"manifest.json").write_text(json.dumps({"expectations_origin":"Original submitted keys/operation/source plus committed registry result UUID observed before replay in the private database; never inferred from receipt fields.","bodies":manifest},indent=2)+"\n")
    report.update(passed=True,response_bytes_never_read_for_both=True,restart_preserved_session=True,
                  observations=rows,actor_isolation=True,changed_payload_conflict=conflict,
                  unchanged_snapshot_on_replay=True,mapping_count=mappings,audit_counts=audits,
                  receipt_metadata_not_persisted=True,activation_claimed=False,
                  correlation_present=args.expect=="after",embedded_openapi_matches_current=args.expect=="after",
                  openapi_sha256=h.sha(ROOT/"contracts/openapi.json") if args.expect=="after" else None)
finally:
    h.stop(process)
    if log: log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-deployment-correlation-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None
    report["private_fixture_removed"]=not temp.exists(); report["harness_sha256"]=h.sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({key:report[key] for key in ["passed","server_sha256","process_stopped","private_fixture_removed"]}))
