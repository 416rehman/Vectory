"""Disposable native HTTP proof for one-shot administrator access edits.

All accounts live in a private temporary server. No live service, account, or
fleet is contacted; passwords and session secrets are absent from evidence.
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

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
sha=lambda path:hashlib.sha256(Path(path).read_bytes()).hexdigest()
fixture=Path(tempfile.mkdtemp(prefix='vectory-access-edit-')).resolve()
process=log=None
connections=[]
report={'recorded_at':datetime.now(timezone.utc).isoformat(),'passed':False,
        'server_sha256':sha(args.server),'scope':__doc__,'activation_claimed':False}

def stop():
    global process,log
    if process is not None and process.poll() is None:
        process.terminate()
        try:process.wait(timeout=15)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=15)
    if log is not None:log.close();log=None

try:
    binary=fixture/'server.exe'
    shutil.copyfile(args.server,binary)
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1',0));port=reserved.getsockname()[1]
    origin=f'http://127.0.0.1:{port}'
    bootstrap=os.urandom(32).hex();password=os.urandom(32).hex()
    (fixture/'bootstrap').write_text(bootstrap,encoding='ascii')
    env={k:v for k,v in os.environ.items() if not k.upper().startswith('VECTORY_')
         and k.upper() not in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY')}
    env.update(VECTORY_DATA_DIR=str(fixture/'state'),VECTORY_HTTP_ADDR=f'127.0.0.1:{port}',
               VECTORY_DEVELOPMENT='true',VECTORY_COOKIE_SECURE='false',
               VECTORY_BOOTSTRAP_SECRET_FILE=str(fixture/'bootstrap'),
               VECTORY_DASHBOARD_DIR=str(fixture),VECTORY_RELEASES_DIR=str(fixture/'releases'))
    database=fixture/'state/vectory.db'
    jar=http.cookiejar.CookieJar()
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
    csrf=''
    def api(path,body=None,expected=200,client=opener,token=None,method=None):
        request=urllib.request.Request(origin+'/api/v1'+path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type':'application/json','X-CSRF-Token':csrf if token is None else token},
            method=method)
        try:response=client.open(request,timeout=15)
        except urllib.error.HTTPError as error:response=error
        with response:status=response.status;value=json.load(response)
        assert status==expected,f'{request.method} {path}: {status} != {expected}'
        return value
    def start():
        global process,log
        log=(fixture/'server.log').open('ab')
        process=subprocess.Popen([str(binary)],cwd=fixture,env=env,stdout=log,stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        for _ in range(150):
            try:api('/status');return
            except (urllib.error.URLError,ConnectionError):time.sleep(.1)
        raise AssertionError('Private server startup timed out')
    def sql(query,values=()):
        with contextlib.closing(sqlite3.connect(database)) as conn:
            return conn.execute(query,values).fetchall()
    def wait_for(query,values=()):
        for _ in range(200):
            rows=sql(query,values)
            if rows:return rows
            time.sleep(.025)
        raise AssertionError('Expected committed fixture record was not found')
    def headers(path):
        request=urllib.request.Request(origin+'/api/v1'+path)
        jar.add_cookie_header(request)
        return {'Content-Type':'application/json','X-CSRF-Token':csrf,
                'Cookie':request.get_header('Cookie')}
    def connection():
        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=15)
        connections.append(conn)
        return conn
    def exact(target,key):return f'/users/{target}/access-requests/{key}'
    def edit_body(key,revision,name,role='editor'):
        return {'request_id':key,'name':name,'role':role,'enabled':True,
                'revision':revision,'current_password':password}
    def revision(target):return sql('SELECT revision FROM users WHERE id=?',(target,))[0][0]
    def audits(action):
        return sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')=?",(action,))[0][0]

    start()
    boot=api('/bootstrap',{'bootstrap_secret':bootstrap,'name':'Synthetic administrator',
        'email':'admin@example.invalid','password':password})
    csrf=boot['csrf_token'];root_id=boot['user']['id']
    target=api('/users',{'name':'Synthetic colleague','email':'colleague@example.invalid',
        'password':password,'role':'viewer'})['id']
    path=f'/users/{target}'
    first_key=str(uuid.uuid4());first_path=exact(target,first_key)
    assert api(first_path)=={'request_id':first_key,'user_id':target,'status':'not_found'}
    lost=connection()
    lost.request('PUT','/api/v1'+path,body=json.dumps(edit_body(first_key,1,'First edit')),
                 headers=headers(path))
    wait_for("SELECT user_json FROM access_edit_requests WHERE request_id=? AND state='applied'",(first_key,))
    lost.close() # Never read status, headers, or committed response body.
    stop();start()
    applied=api(first_path)
    assert applied['status']=='applied' and applied['request_id']==first_key and applied['user_id']==target
    assert applied['user']['name']=='First edit' and applied['user']['role']=='editor'
    assert applied['user']['revision']==2 and applied['user']['id']==target
    assert 'password' not in json.dumps(applied)
    replay=edit_body(first_key,2,'Changed later');replay['current_password']='wrong-password'
    assert api(path,replay,expected=409,method='PUT')['error']['code']=='CONFLICT'
    assert audits('user.update')==1

    admin2=api('/users',{'name':'Second administrator','email':'admin2@example.invalid',
        'password':password,'role':'admin'})
    other_jar=http.cookiejar.CookieJar()
    other_client=urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(other_jar))
    other_csrf=api('/login',{'email':'admin2@example.invalid','password':password},
        client=other_client)['csrf_token']
    assert api(first_path,client=other_client,token=other_csrf)=={
        'request_id':first_key,'user_id':target,'status':'not_found'}
    assert api(first_path+'/cancel',{},client=other_client,token=other_csrf)=={
        'request_id':first_key,'user_id':target,'status':'cancelled'}
    assert api(first_path)==applied
    assert api(exact(admin2['id'],first_key),expected=409)['error']['code']=='CONFLICT'
    assert api(exact(admin2['id'],first_key)+'/cancel',{},expected=409)['error']['code']=='CONFLICT'

    # A later edit may change the account, but exact status retains the first
    # committed public snapshot and cannot be mistaken for a live account read.
    later=api(path,{'name':'Later edit','role':'editor','enabled':True,
        'revision':2,'current_password':password},method='PUT')
    assert later['revision']==3 and later['name']=='Later edit'
    assert api(first_path)==applied
    cancel_audits=audits('user.access_request.cancel')
    assert api(first_path+'/cancel',{})==applied
    assert audits('user.access_request.cancel')==cancel_audits
    assert revision(target)==3

    # Finish a real HTTP body only after cancellation has fenced its key.
    late_key=str(uuid.uuid4());late_path=exact(target,late_key)
    payload=json.dumps(edit_body(late_key,3,'Must not apply')).encode()
    delayed=connection();split=len(payload)//2
    delayed.putrequest('PUT','/api/v1'+path)
    for name,value in headers(path).items():delayed.putheader(name,value)
    delayed.putheader('Content-Length',str(len(payload)))
    delayed.endheaders();delayed.send(payload[:split])
    cancelled=api(late_path+'/cancel',{})
    assert cancelled=={'request_id':late_key,'user_id':target,'status':'cancelled'}
    delayed.send(payload[split:])
    delayed_response=delayed.getresponse();assert delayed_response.status==409
    delayed.close()
    assert api(late_path)==cancelled and revision(target)==3
    assert api(path,edit_body(late_key,3,'Must not apply'),expected=409,method='PUT')['error']['code']=='CONFLICT'
    assert api(late_path+'/cancel',{})==cancelled

    # Fresh key is allowed after cancellation. Its applied status stays exact.
    fresh_key=str(uuid.uuid4());fresh_path=exact(target,fresh_key)
    fresh=api(path,edit_body(fresh_key,3,'Fresh edit','operator'),method='PUT')
    assert fresh['request_id']==fresh_key and fresh['user']['revision']==4
    assert api(fresh_path)['user']==fresh['user']
    assert api(fresh_path+'/cancel',{})['status']=='applied'
    assert audits('user.update')==3

    # Keyed self-demotion commits only with another admin available, and the
    # former admin cannot use the old session to read its own status afterward.
    self_key=str(uuid.uuid4());self_path=exact(admin2['id'],self_key)
    self_edit=api(f"/users/{admin2['id']}",
        {'request_id':self_key,'name':'Second administrator','role':'viewer',
         'enabled':True,'revision':1,'current_password':password},
        client=other_client,token=other_csrf,method='PUT')
    assert self_edit['user']['role']=='viewer' and self_edit['user']['revision']==2
    assert api(self_path,client=other_client,token=other_csrf,expected=401)['error']['code']=='UNAUTHENTICATED'
    assert api(self_path)=={'request_id':self_key,'user_id':admin2['id'],'status':'not_found'}
    root_key=str(uuid.uuid4());root_path=exact(root_id,root_key)
    assert api(f'/users/{root_id}',
        {'request_id':root_key,'name':'Synthetic administrator','role':'admin',
         'enabled':False,'revision':revision(root_id),'current_password':password},
        expected=409,method='PUT')['error']['code']=='CONFLICT'
    assert api(root_path)=={'request_id':root_key,'user_id':root_id,'status':'not_found'}
    assert revision(root_id)==1

    ledger=json.dumps(sql('SELECT * FROM access_edit_requests'))
    assert password not in ledger and 'password_hash' not in ledger
    assert api('/openapi.json')==json.loads((ROOT/'contracts/openapi.json').read_text(encoding='utf-8'))
    report.update(passed=True,groups=7,unread_committed_reply=True,
        restarted_same_datastore=True,actor_isolation=True,immutable_target=True,
        immutable_applied_snapshot=True,keyed_replay_never_reapplied=True,
        late_body_fenced=True,cancel_applied_did_not_undo=True,
        self_demotion_revoked_status_access=True,last_admin_guard=True,
        success_audits=audits('user.update'),
        cancellation_audits=audits('user.access_request.cancel'),
        secret_in_ledger_or_evidence=False,embedded_openapi_matches_current=True,
        source_sha256={name:sha(ROOT/name) for name in
            ['server/src/accounts.rs','server/src/access_requests.rs','server/src/api.rs',
             'server/migrations/0026_access_edit_requests.sql','contracts/openapi.json']})
finally:
    for conn in connections:
        with contextlib.suppress(Exception):conn.close()
    stop()
    assert fixture.parent==Path(tempfile.gettempdir()).resolve() and fixture.name.startswith('vectory-access-edit-')
    shutil.rmtree(fixture)
    report['process_stopped']=process is None or process.poll() is not None
    report['private_fixture_removed']=not fixture.exists()
    report['harness_sha256']=sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({key:report[key] for key in
        ('passed','groups','server_sha256','process_stopped','private_fixture_removed')}))
