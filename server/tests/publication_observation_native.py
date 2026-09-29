"""Disposable real-HTTP unkeyed pipeline-publication response-loss observation.

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
report = {"recorded_at":h.utc(),"scope":"Disposable native server, SQLite and authenticated HTTP. Synthetic accounts and devices; actual unread HTTP response, durable restart lookup and exact keyed replay. No agent activation claimed.","server_sha256":h.sha(args.server),"passed":False}
temp = Path(tempfile.mkdtemp(prefix="vectory-publication-observation-")).resolve()
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
    configuration=api("/configurations",{"name":"Private publication observation","description":"Synthetic fixture","config":pipeline,"graph":{"nodes":[],"edges":[]}})
    path="/configurations/"+configuration["id"]+"/publish"
    payload={"revision":configuration["revision"],"message":"Frozen publish request"}
    request=urllib.request.Request(origin+"/api/v1"+path)
    for handler in admin.handlers:
        if isinstance(handler,urllib.request.HTTPCookieProcessor):handler.cookiejar.add_cookie_header(request)
    connection=http.client.HTTPConnection("127.0.0.1",port,timeout=15)
    connection.request("POST","/api/v1"+path,body=json.dumps(payload),headers={"Content-Type":"application/json","X-CSRF-Token":csrf,"Cookie":request.get_header("Cookie")})
    first=None
    for _ in range(100):
        with contextlib.closing(sqlite3.connect(database)) as db:
            row=db.execute("SELECT data FROM records WHERE kind='version'").fetchone()
        if row:first=json.loads(row[0]);break
        time.sleep(.05)
    assert first;connection.close()
    second=api(path,payload)
    assert first["id"]!=second["id"] and first["number"]==1 and second["number"]==2 and first["sha256"]==second["sha256"] and first["artifact"]==second["artifact"] and first["source_revision"]==second["source_revision"]
    changed=dict(pipeline);changed["sources"]={"in":{"type":"demo_logs","format":"json","interval":2}}
    draft=api("/configurations/"+configuration["id"]+"/draft",{"revision":configuration["revision"],"config":changed,"graph":{"nodes":[],"edges":[]}},method="PUT")
    stale=api(path,payload,expected=409);assert stale["error"]["code"]=="STALE_REVISION"
    current_first=api("/versions/"+first["id"])
    assert current_first==first
    with contextlib.closing(sqlite3.connect(database)) as db:
        count=db.execute("SELECT count(*) FROM records WHERE kind='version'").fetchone()[0]
        audits=db.execute("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='configuration.publish'").fetchone()[0]
        deployments=db.execute("SELECT count(*) FROM records WHERE kind='deployment'").fetchone()[0]
    assert count==audits==2 and deployments==0
    report.update(passed=True,expected_defect_reproduced=True,response_bytes_never_read=True,first_version=first,repeated_version=second,version_count=count,publish_audit_count=audits,duplicate_same_artifact=True,original_immutable_version_unchanged=True,draft_revision_after_edit=draft["revision"],retry_after_draft_edit=stale,no_deployments_created=True,activation_claimed=False)
finally:
    h.stop(process)
    if log:log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith("vectory-publication-observation-")
    shutil.rmtree(temp)
    report["process_stopped"]=process is None or process.poll() is not None;report["private_fixture_removed"]=not temp.exists();report["harness_sha256"]=h.sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True);args.output.resolve().write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({key:report[key] for key in ["passed","server_sha256","process_stopped","private_fixture_removed"]}))
