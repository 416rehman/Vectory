"""Disposable native HTTP device-recovery authorization unread-response proof.

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
temp = Path(tempfile.mkdtemp(prefix='vectory-recovery-request-')).resolve()
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
        return {table:sql(f'SELECT * FROM {table} ORDER BY rowid')for table in ['records','enrollment_tokens','token_requests','devices','credentials','sessions']}
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
    def body(key):return {'request_id':key,'name':'Synthetic enrollment token','expires_hours':24,'max_uses':2,'name_prefix':'synthetic-'}
    def lookup(key):return '/tokens/requests/'+key
    start()
    csrf=api('/bootstrap',{'bootstrap_secret':bootstrap,'name':'Synthetic administrator','email':'admin@example.invalid','password':password})['csrf_token']

    device_id=str(uuid.uuid4());device_name='synthetic-recovery-device'
    device={'id':device_id,'name':device_name,'status':'offline','last_seen':None,'apply_state':'unmanaged','reported_generation':0,'created_at':datetime.now(timezone.utc).isoformat()}
    with contextlib.closing(sqlite3.connect(database)) as db:
        db.execute('INSERT INTO devices(id,name,data) VALUES(?,?,?)',(device_id,device_name,json.dumps(device)));db.commit()
    stable_device=sql('SELECT * FROM devices')
    path='/devices/'+device_id+'/recover'
    lost=connection();lost.request('POST','/api/v1'+path,body='{}',headers=headers())
    first_id=wait_for('SELECT id FROM enrollment_tokens')[0][0]
    first=json.loads(sql('SELECT data FROM enrollment_tokens WHERE id=?',(first_id,))[0][0])
    lost.close() # No response status, headers or body read.
    second=api(path,{})
    assert second['record']['id']!=first_id and second['record']['recovery_device_id']==device_id
    assert second['record']['recovery_name']==first['recovery_name']==device_name
    count=sql("SELECT count(*) FROM enrollment_tokens WHERE json_extract(data,'$.revoked')=0")[0][0]
    audits=sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.recovery_authorize'")[0][0]
    assert count==audits==2 and sql('SELECT * FROM devices')==stable_device
    assert sql('SELECT count(*) FROM credentials')[0][0]==0 and sql('SELECT count(*) FROM enrollments')[0][0]==0
    report.update(passed=True,classification='expected_defect_observation',correctness_acceptance=False,groups=1,committed_creation_response_never_read=True,identical_explicit_retry=True,first_token_id=first_id,second_token_id=second['record']['id'],active_recovery_tokens=count,authorization_audits=audits,synthetic_source_device_id=device_id,first_record=first,second_record=second['record'],device_rows_unchanged=True,credentials=0,enrollments=0,secret_persisted_in_evidence=False,source_sha256={p:sha(ROOT/p)for p in ['server/src/api.rs','server/src/device.rs','server/src/auth.rs','server/src/db.rs','contracts/CONTRACT.md']})

finally:
    for c in connections:
        with contextlib.suppress(Exception):c.close()
    stop()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith('vectory-recovery-request-')
    shutil.rmtree(temp)
    report['process_stopped']=process is None or process.poll()is not None
    report['private_fixture_removed']=not temp.exists()
    report['harness_sha256']=sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:report[k]for k in ['passed','server_sha256','process_stopped','private_fixture_removed']}))
