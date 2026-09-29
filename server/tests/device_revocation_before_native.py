"""Disposable native HTTP device identity revocation unread-response proof.

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
temp = Path(tempfile.mkdtemp(prefix='vectory-revocation-before-')).resolve()
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

    device_id=str(uuid.uuid4());other_id=str(uuid.uuid4());group_id=str(uuid.uuid4())
    now=datetime.now(timezone.utc).isoformat()
    source={'id':device_id,'name':'synthetic-revocation-device','status':'verified','last_seen':now,'apply_state':'verified_applied','reported_generation':7,'created_at':now}
    other=dict(source,id=other_id,name='synthetic-other-identity')
    group={'id':group_id,'name':'Synthetic membership','description':'','device_ids':[device_id,other_id],'revision':1,'created_at':now}
    original_targets=[]
    with contextlib.closing(sqlite3.connect(database)) as db:
        for d in [source,other]:db.execute('INSERT INTO devices(id,name,data,desired_generation,policy_generation) VALUES(?,?,?,7,4)',(d['id'],d['name'],json.dumps(d)))
        for fp,device in [('a'*64,device_id),('b'*64,device_id),('c'*64,other_id)]:db.execute('INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)',(fp,device,'2099-01-01T00:00:00Z'))
        db.execute('INSERT INTO records(kind,id,data,created_at) VALUES(?,?,?,?)',('group',group_id,json.dumps(group),now))
        for mode,status in [('persistent','active'),('persistent','paused'),('persistent','completed'),('persistent','failed'),('snapshot','active')]:
            dep=str(uuid.uuid4());record={'id':dep,'name':'Synthetic target history','status':status,'target_mode':mode,'created_at':now}
            db.execute('INSERT INTO records(kind,id,data,created_at) VALUES(?,?,?,?)',('deployment',dep,json.dumps(record),now))
            db.execute("INSERT INTO deployment_targets(deployment_id,device_id,state,generation,released_at,verified_at,error) VALUES(?,?,'verified',7,?,?,?)",(dep,device_id,now,now,'Historical safe reason'))
            original_targets.append((dep,mode,status))
        db.commit()
    devices_before=sql('SELECT * FROM devices ORDER BY id');other_before=sql('SELECT * FROM devices WHERE id=?',(other_id,))
    path='/devices/'+device_id+'/revoke'
    lost=connection();lost.request('POST','/api/v1'+path,body='{}',headers=headers())
    wait_for("SELECT id FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.revoke'")
    lost.close() # No response status, headers or body read.
    first_audits=sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.revoke'")[0][0]
    first_group=json.loads(sql("SELECT data FROM records WHERE kind='group' AND id=?",(group_id,))[0][0])
    after_first={t:sql(f'SELECT * FROM {t} ORDER BY rowid')for t in ['devices','credentials','deployment_targets']}
    second=api(path,{})
    audits=sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.revoke'")[0][0]
    second_group=json.loads(sql("SELECT data FROM records WHERE kind='group' AND id=?",(group_id,))[0][0])
    assert first_audits==1 and audits==2 and second=={'ok':True}
    assert first_group==second_group and second_group['device_ids']==[other_id] and second_group['revision']==2
    assert after_first=={t:sql(f'SELECT * FROM {t} ORDER BY rowid')for t in after_first}
    assert sql('SELECT revoked FROM devices WHERE id=?',(device_id,))==[(1,)]
    assert sql('SELECT revoked FROM credentials WHERE device_id=?',(device_id,))==[(1,),(1,)]
    assert sql('SELECT * FROM devices WHERE id=?',(other_id,))==other_before and sql('SELECT revoked FROM credentials WHERE device_id=?',(other_id,))==[(0,)]
    target_observations=[]
    for dep,mode,status in original_targets:
        state,generation,released,verified,error=sql('SELECT state,generation,released_at,verified_at,error FROM deployment_targets WHERE deployment_id=?',(dep,))[0]
        assert state==('removed' if mode=='persistent' and status in ['active','paused','completed'] else 'verified')
        assert generation==7 and released==verified==now and error=='Historical safe reason'
        target_observations.append({'mode':mode,'deployment_status':status,'target_state':state,'generation_retained':generation})
    current=api('/devices/'+device_id)
    assert current['id']==device_id and current['status']=='revoked'
    report.update(passed=True,classification='expected_defect_observation',correctness_acceptance=False,groups=1,committed_revocation_response_never_read=True,identical_explicit_retry=True,response=second,first_success_audits=first_audits,after_retry_success_audits=audits,source_device_id=device_id,other_device_unchanged=True,source_credentials_revoked=2,other_credential_active=True,group_revision_first=first_group['revision'],group_revision_retry=second_group['revision'],membership_removed_once=True,targets=target_observations,second_mutation_changes_only_duplicate_audit=True,exact_device_get_reports_revoked=True,secret_persisted_in_evidence=False,source_sha256={p:sha(ROOT/p)for p in ['server/src/api.rs','server/src/device.rs','server/src/auth.rs','server/src/groups.rs','server/src/rollout.rs','contracts/CONTRACT.md']})

finally:
    for c in connections:
        with contextlib.suppress(Exception):c.close()
    stop()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith('vectory-revocation-before-')
    shutil.rmtree(temp)
    report['process_stopped']=process is None or process.poll()is not None
    report['private_fixture_removed']=not temp.exists()
    report['harness_sha256']=sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:report[k]for k in ['passed','server_sha256','process_stopped','private_fixture_removed']}))
