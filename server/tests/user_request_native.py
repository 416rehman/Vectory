"""Disposable native HTTP proof for one-shot administrator user creation.

All accounts, sessions, credentials and requests live in a private temporary
server. An unread committed reply, restart and late-body cancellation are real
TCP events; no production service, account or fleet is contacted.
"""
import argparse
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
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
temp = Path(tempfile.mkdtemp(prefix='vectory-user-request-')).resolve()
bodies = ROOT / '.local/user-request-native-bodies'
bodies.mkdir(parents=True, exist_ok=True)
manifest = []
report = {'recorded_at':datetime.now(timezone.utc).isoformat(), 'passed':False,
          'server_sha256':sha(args.server), 'scope':__doc__, 'activation_claimed':False}
process = log = None
connections = []

def emit(name, value, schema):
    assert 'password' not in json.dumps(value).lower()
    filename = name + '.json'
    (bodies / filename).write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    manifest.append({'file':filename,'schema':schema})

def stop():
    global process, log
    if process is not None and process.poll() is None:
        process.terminate()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=15)
    if log is not None:
        log.close(); log = None

try:
    binary = temp / 'server.exe'
    shutil.copyfile(args.server, binary)
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1',0))
        port = reserved.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    bootstrap = os.urandom(32).hex()
    password = os.urandom(32).hex()
    (temp / 'bootstrap').write_text(bootstrap)
    env = {key:value for key,value in os.environ.items() if not key.upper().startswith('VECTORY_') and key.upper() not in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']}
    env.update(VECTORY_DATA_DIR=str(temp / 'state'),VECTORY_HTTP_ADDR=f'127.0.0.1:{port}',VECTORY_DEVELOPMENT='true',VECTORY_COOKIE_SECURE='false',VECTORY_BOOTSTRAP_SECRET_FILE=str(temp / 'bootstrap'),VECTORY_DASHBOARD_DIR=str(temp),VECTORY_RELEASES_DIR=str(temp / 'releases'))
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
    csrf = ''
    database = temp / 'state/vectory.db'

    def api(path,body=None,expected=200,client=opener,token=None):
        headers={'Content-Type':'application/json','X-CSRF-Token':csrf if token is None else token}
        request=urllib.request.Request(origin+'/api/v1'+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
        try: response=client.open(request,timeout=15)
        except urllib.error.HTTPError as error: response=error
        with response: status=response.status; value=json.load(response)
        assert status==expected,f'{request.method} {path}: {status} != {expected}'
        return value

    def start():
        global process,log
        log=(temp/'server.log').open('ab')
        process=subprocess.Popen([str(binary)],cwd=temp,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        for _ in range(150):
            try: api('/status');return
            except (urllib.error.URLError,ConnectionError): time.sleep(.1)
        raise AssertionError('Private server startup timed out')

    def sql(query,params=()):
        with contextlib.closing(sqlite3.connect(database)) as connection:
            return connection.execute(query,params).fetchall()

    def wait_for(query,params=()):
        for _ in range(200):
            result=sql(query,params)
            if result:return result
            time.sleep(.025)
        raise AssertionError('Private transaction did not commit')

    def headers():
        request=urllib.request.Request(origin+'/api/v1/users')
        jar.add_cookie_header(request)
        return {'Content-Type':'application/json','X-CSRF-Token':csrf,'Cookie':request.get_header('Cookie')}

    def new_connection():
        connection=http.client.HTTPConnection('127.0.0.1',port,timeout=15)
        connections.append(connection)
        return connection

    def create_body(key,email):
        return {'request_id':key,'name':'Synthetic colleague','email':email,'password':password,'role':'viewer','current_password':password}

    start()
    csrf=api('/bootstrap',{'bootstrap_secret':bootstrap,'name':'Synthetic administrator','email':'admin@example.invalid','password':password})['csrf_token']
    key=str(uuid.uuid4())
    path='/users/requests/'+key
    absent=api(path)
    assert absent=={'request_id':key,'status':'not_found'}
    emit('native_absent',absent,'UserRequestStatus')

    # The server commits a user and registry identity; the client does not read
    # the status, headers or body. A process restart does not erase the result.
    lost=new_connection()
    lost.request('POST','/api/v1/users',body=json.dumps(create_body(key,'colleague@example.invalid')),headers=headers())
    user_id=wait_for('SELECT user_id FROM user_requests WHERE request_id=? AND state=\'created\'',(key,))[0][0]
    lost.close()
    stop();start()
    found=api(path)
    assert found['request_id']==key and found['status']=='created' and found['user']['id']==user_id
    assert found['user']['email']=='colleague@example.invalid'
    assert 'password' not in json.dumps(found)
    emit('native_created_status',found,'UserRequestStatus')
    duplicate=api('/users',create_body(key,'colleague@example.invalid'),expected=409)
    assert duplicate['error']['code']=='REQUEST_ALREADY_USED'
    emit('native_duplicate',duplicate,'Error')
    assert sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='user.create'")[0][0]==1
    assert sql("SELECT count(*) FROM users WHERE email='colleague@example.invalid'")[0][0]==1

    # One-shot cancellation does not disable or delete a user that already won.
    created_cancel=api(path+'/cancel',{})
    assert created_cancel==found and api(path)==found
    emit('native_created_cancel',created_cancel,'UserRequestStatus')

    # Begin a real HTTP request and withhold half its JSON body. Cancellation
    # wins the writer before the old body is completed, fencing the late POST.
    late_key=str(uuid.uuid4())
    late_path='/users/requests/'+late_key
    payload=json.dumps(create_body(late_key,'late@example.invalid')).encode()
    split=len(payload)//2
    delayed=new_connection()
    delayed.putrequest('POST','/api/v1/users')
    for name,value in headers().items(): delayed.putheader(name,value)
    delayed.putheader('Content-Length',str(len(payload)))
    delayed.endheaders();delayed.send(payload[:split])
    cancelled=api(late_path+'/cancel',{})
    assert cancelled=={'request_id':late_key,'status':'cancelled'}
    delayed.send(payload[split:])
    response=delayed.getresponse();assert response.status==409
    delayed.close()
    assert api(late_path)==cancelled
    assert sql("SELECT count(*) FROM users WHERE email='late@example.invalid'")[0][0]==0
    emit('native_cancelled',cancelled,'UserRequestStatus')

    # A fresh first-send receipt has a different shape from a status read.
    fresh_key=str(uuid.uuid4())
    receipt=api('/users',create_body(fresh_key,'receipt@example.invalid'))
    assert receipt['request_id']==fresh_key and receipt['user']['email']=='receipt@example.invalid'
    assert 'password' not in json.dumps(receipt)
    emit('native_receipt',receipt,'UserCreateReceipt')
    legacy=api('/users',{'name':'Legacy','email':'legacy@example.invalid','password':password,'role':'viewer','current_password':password})
    assert 'request_id' not in legacy and legacy['email']=='legacy@example.invalid'
    emit('native_legacy',legacy,'User')
    assert api('/openapi.json')==json.loads((ROOT/'contracts/openapi.json').read_text(encoding='utf-8'))
    stored=sql('SELECT actor_id,request_id,state,user_id,created_at,cancelled_at FROM user_requests')
    assert password not in json.dumps(stored)
    assert sql('SELECT count(*) FROM user_requests')[0][0]==3
    (bodies/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    report.update(passed=True,groups=4,unread_committed_reply=True,restarted_same_datastore=True,
                  late_original_started_before_cancel=True,second_create_after_cancel=False,
                  user_create_audit_count=sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='user.create'")[0][0],
                  password_in_registry_or_output=False,embedded_openapi_matches_current=True,
                  body_manifest=str((bodies/'manifest.json').relative_to(ROOT)),
                  source_sha256={name:sha(ROOT/name) for name in ['server/src/user_requests.rs','server/src/auth.rs','server/src/api.rs','server/src/lib.rs','server/migrations/0024_user_requests.sql','contracts/openapi.json']})
finally:
    for connection in connections:
        with contextlib.suppress(Exception):connection.close()
    stop()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith('vectory-user-request-')
    shutil.rmtree(temp)
    report['process_stopped']=process is None or process.poll() is not None
    report['private_fixture_removed']=not temp.exists()
    report['harness_sha256']=sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({key:report[key] for key in ['passed','server_sha256','process_stopped','private_fixture_removed']}))
