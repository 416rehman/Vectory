"""Disposable real-HTTP pipeline creation and duplication response-loss observations.

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
report = {"recorded_at":h.utc(),"scope":"Disposable native server, SQLite and authenticated HTTP. Synthetic account and configurations; two actual unread committed HTTP responses followed by identical retries. No agent activation claimed.","server_sha256":h.sha(args.server),"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-pipeline-create-observation-")).resolve()
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
    payload={"name":"Synthetic creation response loss","description":"Private fixture","config":pipeline,"graph":{"nodes":[],"edges":[]}}
    first=unread_commit("/configurations",payload,payload["name"])
    second=api("/configurations",payload)
    assert first["id"]!=second["id"] and first["config"]==second["config"] and first["graph"]==second["graph"] and first["revision"]==second["revision"]==1
    source_before=api("/configurations/"+first["id"])
    history_before=api("/configurations/"+first["id"]+"/history?kind=revisions")
    duplicate_payload={"revision":1,"name":"Synthetic clone response loss","description":"Private copy"}
    duplicate_path="/configurations/"+first["id"]+"/duplicate"
    clone=unread_commit(duplicate_path,duplicate_payload,duplicate_payload["name"])
    repeated_clone=api(duplicate_path,duplicate_payload)
    assert clone["id"]!=repeated_clone["id"] and clone["config"]==repeated_clone["config"]==first["config"] and clone["graph"]==repeated_clone["graph"]==first["graph"]
    assert api("/configurations/"+first["id"])==source_before and api("/configurations/"+first["id"]+"/history?kind=revisions")==history_before
    with contextlib.closing(sqlite3.connect(database)) as db:
        counts={kind:db.execute("SELECT count(*) FROM records WHERE kind=?",(kind,)).fetchone()[0] for kind in ["configuration","revision","version","deployment"]}
        audits={action:db.execute("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')=?",(action,)).fetchone()[0] for action in ["configuration.create","configuration.duplicate"]}
        devices=db.execute("SELECT count(*) FROM devices").fetchone()[0]
    assert counts=={"configuration":4,"revision":4,"version":0,"deployment":0} and audits=={"configuration.create":2,"configuration.duplicate":2} and devices==0
    report.update(passed=True,expected_defect_reproduced=True,response_bytes_never_read_for_both=True,create={"first":first,"repeated":second,"distinct_result_ids":True},duplicate={"first":clone,"repeated":repeated_clone,"distinct_result_ids":True,"source_revision_still":source_before["revision"],"source_configuration_and_history_unchanged":True},record_counts=counts,audit_counts=audits,no_devices_or_deployments=True,activation_claimed=False)

finally:
    h.stop(process)
    if log:log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-pipeline-create-observation-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None;report["private_fixture_removed"]=not temp.exists();report["harness_sha256"]=h.sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True);args.output.resolve().write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({key:report[key] for key in ["passed","server_sha256","process_stopped","private_fixture_removed"]}))
