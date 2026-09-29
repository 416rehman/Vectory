"""Disposable native HTTP device-recovery-request cancellation and unread-response proof.

No agent, production account, service or fleet is contacted. Secrets are confined
to the private fixture and never included in the published evidence.
"""
import argparse
import concurrent.futures
import contextlib
import hashlib
import http.client
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
temp = Path(tempfile.mkdtemp(prefix='vectory-recovery-request-after-')).resolve()
report = {'recorded_at':datetime.now(timezone.utc).isoformat(), 'passed':False,
          'server_sha256':sha(args.server), 'scope':__doc__, 'activation_claimed':False}
process = log = None
connections = []
manifest = []
bodies = ROOT / '.local/device-recovery-request-native-bodies'
bodies.mkdir(parents=True,exist_ok=True)

def stop():
    global process, log
    if process is not None and process.poll() is None:
        process.terminate()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired: process.kill();process.wait(timeout=15)
    if log is not None: log.close(); log = None

def emit(name, value, schema):
    assert 'token' not in value, 'Raw one-time token must not enter evidence'
    file = name+'.json'
    (bodies/file).write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
    manifest.append({'file':file,'schema':schema})

try:
    binary=temp/'server.exe';shutil.copyfile(args.server,binary)
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1',0));port=reserved.getsockname()[1]
    origin=f'http://127.0.0.1:{port}'
    bootstrap=os.urandom(32).hex();password=os.urandom(32).hex()
    (temp/'bootstrap').write_text(bootstrap)
    env={k:v for k,v in os.environ.items() if not k.upper().startswith('VECTORY_') and k.upper() not in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']}
    env.update(VECTORY_DATA_DIR=str(temp/'state'),VECTORY_HTTP_ADDR=f'127.0.0.1:{port}',VECTORY_DEVELOPMENT='true',VECTORY_COOKIE_SECURE='false',VECTORY_BOOTSTRAP_SECRET_FILE=str(temp/'bootstrap'),VECTORY_DASHBOARD_DIR=str(temp),VECTORY_RELEASES_DIR=str(temp/'releases'))
    jar=http.cookiejar.CookieJar()
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
    csrf=''
    database=temp/'state/vectory.db'
    def api(path,body=None,expected=200):
        req=urllib.request.Request(origin+'/api/v1'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','X-CSRF-Token':csrf})
        try: response=opener.open(req,timeout=15)
        except urllib.error.HTTPError as e: response=e
        with response: status=response.status;value=json.load(response)
        assert status==expected,f'{req.method} {path} got {status}; expected {expected}'
        return value
    def start():
        global process,log
        log=(temp/'server.log').open('ab')
        process=subprocess.Popen([str(binary)],cwd=temp,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        for _ in range(150):
            try: api('/status');return
            except (urllib.error.URLError,ConnectionError): time.sleep(.1)
        raise AssertionError('Private server startup timed out')
    def sql(query,args=()):
        with contextlib.closing(sqlite3.connect(database)) as db: return db.execute(query,args).fetchall()
    def snapshot():
        return {table:sql(f'SELECT * FROM {table} ORDER BY rowid')for table in ['records','enrollment_tokens','device_recovery_requests','devices','credentials','sessions']}
    def headers():
        req=urllib.request.Request(origin+'/api/v1/tokens');jar.add_cookie_header(req)
        return {'Content-Type':'application/json','X-CSRF-Token':csrf,'Cookie':req.get_header('Cookie')}
    def connection():
        c=http.client.HTTPConnection('127.0.0.1',port,timeout=15);connections.append(c);return c
    def wait_for(query,params=()):
        for _ in range(200):
            rows=sql(query,params)
            if rows:return rows
            time.sleep(.025)
        raise AssertionError('Expected committed fixture record was not found')
    def body(key):return {'request_id':key,'expected_name':device_name}
    def lookup(key):return '/devices/'+device_id+'/recovery-requests/'+key
    start()
    csrf=api('/bootstrap',{'bootstrap_secret':bootstrap,'name':'Synthetic administrator','email':'admin@example.invalid','password':password})['csrf_token']

    device_id=str(uuid.uuid4());device_name='synthetic-recovery-device'
    device={'id':device_id,'name':device_name,'status':'offline','last_seen':None,'apply_state':'unmanaged','reported_generation':0,'created_at':datetime.now(timezone.utc).isoformat()}
    with contextlib.closing(sqlite3.connect(database)) as db:
        db.execute('INSERT INTO devices(id,name,data) VALUES(?,?,?)',(device_id,device_name,json.dumps(device)));db.commit()
    stable_device=sql('SELECT * FROM devices')
    path='/devices/'+device_id+'/recover'

    # The first POST is committed, but its status, headers and body are never read.
    key=str(uuid.uuid4());request=body(key);absent=api(lookup(key));assert absent['found'] is False and absent['request_correlation'] is True
    lost=connection();lost.request('POST','/api/v1'+path,body=json.dumps(request),headers=headers())
    token_id=wait_for('SELECT token_id FROM device_recovery_requests WHERE request_id=?',(key,))[0][0]
    lost.close()
    stop();start()
    stable=snapshot();found=api(lookup(key));replayed=api(path,request)
    assert found==replayed and found['record']['id']==token_id and found['state']=='created' and 'token'not in found
    assert snapshot()==stable
    conflict=api(path,dict(request,expected_name='Different'),expected=409);assert conflict['error']['code']=='IDEMPOTENCY_CONFLICT' and snapshot()==stable
    assert sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.recovery_authorize'")[0][0]==1
    emit('native_absent',absent,'DeviceRecoveryRequestStatus');emit('native_replay',replayed,'DeviceRecoveryRequestStatus');emit('native_conflict',conflict,'Error')

    with contextlib.closing(sqlite3.connect(database)) as db:
        db.execute("UPDATE devices SET name=name||'#retired-'||id,revoked=1 WHERE id=?",(device_id,));db.commit()
    stable_device=sql('SELECT * FROM devices');stable=snapshot()
    assert api(lookup(key))==found and api(path,request)==found and snapshot()==stable
    emit('native_retired_source_replay',found,'DeviceRecoveryRequestStatus')

    # Losing cancellation's response is also recoverable across a process restart.
    lost_cancel=connection();lost_cancel.request('POST','/api/v1'+lookup(key)+'/cancel',body='{}',headers=headers())
    wait_for("SELECT request_id FROM device_recovery_requests WHERE request_id=? AND state='cancelled'",(key,));lost_cancel.close()
    stop();start();cancelled=api(lookup(key));assert cancelled['state']=='cancelled' and cancelled['record']['id']==token_id and cancelled['record']['revoked'] is True
    stable=snapshot();assert api(lookup(key)+'/cancel',{})==cancelled;assert api(path,request)==cancelled;assert snapshot()==stable
    emit('native_cancelled',cancelled,'DeviceRecoveryRequestStatus')

    # An actual earlier request remains stalled mid-body while cancel commits.
    # Finishing that body afterwards must return the tombstone, never a new secret.
    delayed_key=str(uuid.uuid4());raw=json.dumps(body(delayed_key)).encode();split=len(raw)//2
    delayed=connection();delayed.putrequest('POST','/api/v1'+path)
    for k,v in headers().items():delayed.putheader(k,v)
    delayed.putheader('Content-Length',str(len(raw)));delayed.endheaders();delayed.send(raw[:split])
    closed=api(lookup(delayed_key)+'/cancel',{});assert closed['record'] is None and closed['state']=='cancelled'
    delayed.send(raw[split:]);response=delayed.getresponse();assert response.status==200;late=json.load(response);delayed.close();assert late==closed
    stable=snapshot();assert api(path,body(delayed_key))==closed;assert snapshot()==stable
    emit('native_cancelled_before_late',closed,'DeviceRecoveryRequestStatus')

    retired_source_id=device_id
    device_id=str(uuid.uuid4());device_name='synthetic-race-device';device=dict(device,id=device_id,name=device_name)
    with contextlib.closing(sqlite3.connect(database)) as db:
        db.execute('INSERT INTO devices(id,name,data) VALUES(?,?,?)',(device_id,device_name,json.dumps(device)));db.commit()
    stable_device=sql('SELECT * FROM devices');path='/devices/'+device_id+'/recover'

    # Real simultaneous independent HTTP requests exercise either writer order.
    for _ in range(5):
        race_key=str(uuid.uuid4());barrier=threading.Barrier(2)
        def send_pair(path,payload):
            c=connection();barrier.wait(timeout=5);c.request('POST','/api/v1'+path,body=json.dumps(payload),headers=headers());r=c.getresponse();assert r.status==200;v=json.load(r);c.close();return v
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            a=pool.submit(send_pair,path,body(race_key));b=pool.submit(send_pair,lookup(race_key)+'/cancel',{})
            made=a.result(timeout=20);fenced=b.result(timeout=20)
        assert fenced['state']=='cancelled' and (fenced['record']is None or fenced['record']['revoked']is True)
        assert api(lookup(race_key))==fenced and api(path,body(race_key))==fenced
    assert sql("SELECT count(*) FROM enrollment_tokens WHERE json_extract(data,'$.revoked')=0")[0][0]==0
    assert sql('SELECT * FROM devices')==stable_device and sql('SELECT count(*) FROM credentials')[0][0]==0
    assert api('/openapi.json')==json.loads((ROOT/'contracts/openapi.json').read_text(encoding='utf-8'))
    (bodies/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    report.update(passed=True,groups=4,groups_description=['Committed creation reply never read; restart exact status and secret-free replay create no extra record/audit','Committed cancellation reply never read; restart status and explicit repeated cancel/replay are no-ops','Original request held mid-body, cancellation commits first, then late body cannot create a token','Five real simultaneous create/cancel HTTP pairs serialize with no usable orphan'],committed_creation_response_never_read=True,committed_cancel_response_never_read=True,restarted_same_datastore=True,delayed_original_started_before_cancel=True,concurrent_pairs=5,active_tokens=0,devices=2,credentials=0,source_retired_only_by_fixture=True,replay_after_retirement_preserved_original=True,device_rows_unchanged_by_authorization_or_cancel=True,embedded_openapi_matches_current=True,secret_persisted_in_evidence=False,body_manifest=str((bodies/'manifest.json').relative_to(ROOT)),source_sha256={p:sha(ROOT/p)for p in ['server/src/device_recovery_requests.rs','server/src/token_requests.rs','server/src/api.rs','server/src/device.rs','server/src/auth.rs','server/src/db.rs','server/src/lib.rs','server/migrations/0022_device_recovery_requests.sql','contracts/openapi.json']})
finally:
    for c in connections:
        with contextlib.suppress(Exception):c.close()
    stop()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith('vectory-recovery-request-after-')
    shutil.rmtree(temp)
    report['process_stopped']=process is None or process.poll()is not None
    report['private_fixture_removed']=not temp.exists()
    report['harness_sha256']=sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:report[k]for k in ['passed','server_sha256','process_stopped','private_fixture_removed']}))
