"""Disposable native HTTP proof for administrator reset issuance recovery.

Every account and reset code lives in a private temporary server. No live
service, real account or fleet is contacted. Evidence never includes a code.
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
parser.add_argument('--server', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
fixture = Path(tempfile.mkdtemp(prefix='vectory-reset-request-')).resolve()
process = log = None
connections = []
report = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'passed': False,
          'server_sha256': sha(args.server), 'scope': __doc__, 'activation_claimed': False}

def stop():
    global process, log
    if process is not None and process.poll() is None:
        process.terminate()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=15)
    if log is not None: log.close(); log = None

try:
    binary = fixture / 'server.exe'
    shutil.copyfile(args.server, binary)
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1', 0)); port = reserved.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    bootstrap = os.urandom(32).hex(); password = os.urandom(32).hex()
    next_password = os.urandom(32).hex()
    (fixture / 'bootstrap').write_text(bootstrap, encoding='ascii')
    env = {k:v for k,v in os.environ.items() if not k.upper().startswith('VECTORY_') and k.upper() not in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY')}
    env.update(VECTORY_DATA_DIR=str(fixture/'state'),VECTORY_HTTP_ADDR=f'127.0.0.1:{port}',
               VECTORY_DEVELOPMENT='true',VECTORY_COOKIE_SECURE='false',
               VECTORY_BOOTSTRAP_SECRET_FILE=str(fixture/'bootstrap'),
               VECTORY_DASHBOARD_DIR=str(fixture),VECTORY_RELEASES_DIR=str(fixture/'releases'))
    database = fixture/'state/vectory.db'
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
    csrf = ''
    def api(path,body=None,expected=200,client=opener,token=None,method=None):
        request = urllib.request.Request(origin+'/api/v1'+path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type':'application/json','X-CSRF-Token':csrf if token is None else token},
            method=method)
        try: response = client.open(request,timeout=15)
        except urllib.error.HTTPError as error: response = error
        with response: status = response.status; value = json.load(response)
        assert status == expected, f'{request.method} {path}: {status} != {expected}'
        return value
    def start():
        global process, log
        log = (fixture/'server.log').open('ab')
        process = subprocess.Popen([str(binary)],cwd=fixture,env=env,stdout=log,stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        for _ in range(150):
            try: api('/status'); return
            except (urllib.error.URLError, ConnectionError): time.sleep(.1)
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
    def endpoint(target,key):return f'/users/{target}/password-reset/requests/{key}'
    def issue_body(key,revision):
        return {'request_id':key,'current_password':password,'revision':revision}
    def current_revision(target):
        return sql('SELECT revision FROM users WHERE id=?',(target,))[0][0]
    def audits(action):
        return sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')=?",(action,))[0][0]

    start()
    csrf=api('/bootstrap',{'bootstrap_secret':bootstrap,'name':'Synthetic administrator',
        'email':'admin@example.invalid','password':password})['csrf_token']
    target=api('/users',{'name':'Synthetic colleague','email':'colleague@example.invalid',
        'password':password,'role':'viewer'})['id']
    path=f'/users/{target}/password-reset'
    first_key=str(uuid.uuid4()); first_status_path=endpoint(target,first_key)
    assert api(first_status_path)=={'request_id':first_key,'user_id':target,'status':'not_found'}
    lost=connection()
    lost.request('POST','/api/v1'+path,body=json.dumps(issue_body(first_key,1)),headers=headers(path))
    wait_for("SELECT verifier FROM password_reset_requests WHERE request_id=? AND state='issued'",(first_key,))
    lost.close()  # Never read status, headers or one-time code body.
    stop();start()
    first=api(first_status_path)
    assert first=={'request_id':first_key,'user_id':target,'status':'issued',
                   'active':True,'expires_at':first['expires_at']}
    assert 'code' not in first and 'verifier' not in first
    assert api(path,issue_body(first_key,2),expected=409)['error']['code']=='CONFLICT'
    assert audits('user.password_reset.issue')==1
    assert current_revision(target)==2

    # A different administrator cannot observe or revoke the first actor's
    # request, even with its exact request ID and target UUID.
    admin2=api('/users',{'name':'Second administrator','email':'admin2@example.invalid',
        'password':password,'role':'admin'})
    other_jar=http.cookiejar.CookieJar()
    other_client=urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(other_jar))
    other_csrf=api('/login',{'email':'admin2@example.invalid','password':password},client=other_client)['csrf_token']
    assert api(first_status_path,client=other_client,token=other_csrf)=={
        'request_id':first_key,'user_id':target,'status':'not_found'}
    assert api(first_status_path+'/cancel',{},client=other_client,token=other_csrf)=={
        'request_id':first_key,'user_id':target,'status':'cancelled','was_issued':False}
    assert api(first_status_path)['active'] is True
    assert admin2['id']!=target

    cancelled=api(first_status_path+'/cancel',{})
    assert cancelled=={'request_id':first_key,'user_id':target,'status':'cancelled','was_issued':True}
    assert api(first_status_path)==cancelled
    assert current_revision(target)==3
    assert sql('SELECT count(*) FROM password_reset_codes WHERE user_id=?',(target,))[0][0]==0
    assert api(path,issue_body(first_key,3),expected=409)['error']['code']=='CONFLICT'

    # A later request may issue another code; cancelling the old key again is
    # idempotent and must not touch this newer code.
    second_key=str(uuid.uuid4()); second_path=endpoint(target,second_key)
    second=api(path,issue_body(second_key,3))
    assert second['request_id']==second_key and second['user_id']==target
    assert len(second['code'])==64 and api(second_path)['active'] is True
    cancellations_before_repeat=audits('user.password_reset.request.cancel')
    assert api(first_status_path+'/cancel',{})==cancelled
    assert audits('user.password_reset.request.cancel')==cancellations_before_repeat
    assert api(second_path)['active'] is True and current_revision(target)==4
    assert api('/password-reset',{'code':second['code'],'new_password':next_password})=={'ok':True}
    assert api(second_path)['active'] is False
    assert api(second_path+'/cancel',{})=={
        'request_id':second_key,'user_id':target,'status':'cancelled','was_issued':True}
    assert current_revision(target)==5  # Redemption changed the password; cancellation did not.

    # The target can receive a fresh code after a completed password reset.
    third_key=str(uuid.uuid4()); third_path=endpoint(target,third_key)
    third=api(path,issue_body(third_key,5))
    assert api(third_path)['active'] is True
    # A stale path for this actor's known key conflicts rather than rebinding.
    wrong_target=admin2['id']
    assert api(endpoint(wrong_target,third_key),expected=409)['error']['code']=='CONFLICT'
    assert api(endpoint(wrong_target,third_key)+'/cancel',{},expected=409)['error']['code']=='CONFLICT'

    # Complete a real HTTP body only after cancellation has committed.
    late_key=str(uuid.uuid4()); late_path=endpoint(target,late_key)
    payload=json.dumps(issue_body(late_key,current_revision(target))).encode()
    delayed=connection();split=len(payload)//2
    delayed.putrequest('POST','/api/v1'+path)
    for name,value in headers(path).items(): delayed.putheader(name,value)
    delayed.putheader('Content-Length',str(len(payload)))
    delayed.endheaders();delayed.send(payload[:split])
    late_cancel=api(late_path+'/cancel',{})
    assert late_cancel=={'request_id':late_key,'user_id':target,'status':'cancelled','was_issued':False}
    delayed.send(payload[split:])
    late_response=delayed.getresponse();assert late_response.status==409
    delayed.close()
    assert api(late_path)==late_cancel
    assert api(third_path)['active'] is True

    # Expiry is distinct from an active code; cancellation removes an expired
    # verifier without claiming that a password change was reversed.
    with contextlib.closing(sqlite3.connect(database)) as conn:
        conn.execute("UPDATE password_reset_codes SET expires_at='2000-01-01T00:00:00Z' WHERE user_id=?",(target,))
        conn.commit()
    assert api(third_path)['active'] is False
    revision=current_revision(target)
    assert api(third_path+'/cancel',{})['was_issued'] is True
    assert current_revision(target)==revision
    assert api('/password-reset',{'code':third['code'],'new_password':next_password},expected=401)['error']['code']=='UNAUTHENTICATED'

    # The issuer, not only the target, owns the reset capability. A harmless
    # name edit preserves keyed and legacy codes; role downgrade revokes both.
    role_keyed_target=api('/users',{'name':'Keyed role target','email':'keyed-role@example.invalid',
        'password':password,'role':'viewer'})['id']
    role_legacy_target=api('/users',{'name':'Legacy role target','email':'legacy-role@example.invalid',
        'password':password,'role':'viewer'})['id']
    role_key=str(uuid.uuid4()); role_path=endpoint(role_keyed_target,role_key)
    role_code=api(f'/users/{role_keyed_target}/password-reset',issue_body(role_key,1),
        client=other_client,token=other_csrf)['code']
    legacy_code=api(f'/users/{role_legacy_target}/password-reset',
        {'current_password':password,'revision':1},client=other_client,token=other_csrf)['code']
    assert api(role_path,client=other_client,token=other_csrf)['active'] is True
    assert sql('SELECT count(*) FROM password_reset_codes WHERE issuer_id=?',(admin2['id'],))[0][0]==2
    admin2_path=f"/users/{admin2['id']}"
    renamed=api(admin2_path,{'name':'Renamed administrator','role':'admin','enabled':True,
        'revision':current_revision(admin2['id']),'current_password':password},method='PUT')
    assert renamed['revision']==2
    assert sql('SELECT count(*) FROM password_reset_codes WHERE issuer_id=?',(admin2['id'],))[0][0]==2
    assert api(role_path,client=other_client,token=other_csrf)['active'] is True
    downgraded=api(admin2_path,{'name':'Renamed administrator','role':'viewer','enabled':True,
        'revision':2,'current_password':password},method='PUT')
    assert downgraded['revision']==3
    assert sql('SELECT count(*) FROM password_reset_codes WHERE issuer_id=?',(admin2['id'],))[0][0]==0
    assert current_revision(role_keyed_target)==3 and current_revision(role_legacy_target)==3
    assert api(role_path,client=other_client,token=other_csrf,expected=401)['error']['code']=='UNAUTHENTICATED'
    for code in (role_code,legacy_code):
        assert api('/password-reset',{'code':code,'new_password':next_password},expected=401)['error']['code']=='UNAUTHENTICATED'
    promoted=api(admin2_path,{'name':'Renamed administrator','role':'admin','enabled':True,
        'revision':3,'current_password':password},method='PUT')
    assert promoted['revision']==4
    other_csrf=api('/login',{'email':'admin2@example.invalid','password':password},client=other_client)['csrf_token']
    assert api(role_path,client=other_client,token=other_csrf)['active'] is False
    assert api(role_path+'/cancel',{},client=other_client,token=other_csrf)['was_issued'] is True
    assert current_revision(role_keyed_target)==3

    # Changing the issuer's password also revokes codes for other users.
    rotation_target=api('/users',{'name':'Rotation target','email':'rotation@example.invalid',
        'password':password,'role':'viewer'})['id']
    rotation_key=str(uuid.uuid4()); rotation_path=endpoint(rotation_target,rotation_key)
    rotation_code=api(f'/users/{rotation_target}/password-reset',issue_body(rotation_key,1),
        client=other_client,token=other_csrf)['code']
    assert api(rotation_path,client=other_client,token=other_csrf)['active'] is True
    rotated=api('/account/password',{'current_password':password,'new_password':next_password},
        client=other_client,token=other_csrf)
    other_csrf=rotated['csrf_token']
    assert api(rotation_path,client=other_client,token=other_csrf)['active'] is False
    assert current_revision(rotation_target)==3
    assert api('/password-reset',{'code':rotation_code,'new_password':password},expected=401)['error']['code']=='UNAUTHENTICATED'

    # Disabling an administrator revokes another unused legacy issue too.
    disable_target=api('/users',{'name':'Disable target','email':'disable@example.invalid',
        'password':password,'role':'viewer'})['id']
    disable_code=api(f'/users/{disable_target}/password-reset',
        {'current_password':next_password,'revision':1},client=other_client,token=other_csrf)['code']
    disabled=api(admin2_path,{'name':'Renamed administrator','role':'admin','enabled':False,
        'revision':current_revision(admin2['id']),'current_password':password},method='PUT')
    assert disabled['enabled'] is False
    assert current_revision(disable_target)==3
    assert sql('SELECT count(*) FROM password_reset_codes WHERE issuer_id=?',(admin2['id'],))[0][0]==0
    assert api('/password-reset',{'code':disable_code,'new_password':next_password},expected=401)['error']['code']=='UNAUTHENTICATED'

    # The request registry contains no plaintext code, password, or password
    # verifier; all request status and cancellation responses are metadata-only.
    registry=json.dumps(sql('SELECT * FROM password_reset_requests'))
    for secret in (password,next_password,second['code'],third['code']):
        assert secret not in registry
    assert api('/openapi.json')==json.loads((ROOT/'contracts/openapi.json').read_text(encoding='utf-8'))
    report.update(passed=True,groups=9,unread_committed_reply=True,
        restarted_same_datastore=True,secret_recovery_from_status=False,
        replay_issued_second_code=False,actor_isolation=True,immutable_target=True,
        cancel_only_exact_current_code=True,redeemed_change_not_undone=True,
        late_body_fenced=True,expired_code_inactive=True,
        issuer_role_downgrade_revoked_keyed_and_legacy=True,
        issuer_name_edit_preserved_codes=True,
        issuer_password_rotation_revoked_cross_target_code=True,
        issuer_disable_revoked_legacy_code=True,
        issuance_audits=audits('user.password_reset.issue'),
        cancellation_audits=audits('user.password_reset.request.cancel'),
        secret_in_registry_or_evidence=False,embedded_openapi_matches_current=True,
        source_sha256={name:sha(ROOT/name) for name in
            ['server/src/accounts.rs','server/src/reset_requests.rs','server/src/api.rs',
             'server/migrations/0025_password_reset_requests.sql','contracts/openapi.json']})
finally:
    for conn in connections:
        with contextlib.suppress(Exception):conn.close()
    stop()
    assert fixture.parent==Path(tempfile.gettempdir()).resolve() and fixture.name.startswith('vectory-reset-request-')
    shutil.rmtree(fixture)
    report['process_stopped']=process is None or process.poll() is not None
    report['private_fixture_removed']=not fixture.exists()
    report['harness_sha256']=sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({key:report[key] for key in
        ('passed','groups','server_sha256','process_stopped','private_fixture_removed')}))
