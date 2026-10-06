"""Disposable native HTTP proof of an unread committed Edit access response.

The fixture uses a private loopback server and synthetic accounts. No live
service, real account, or fleet is contacted; no password enters evidence.
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
fixture = Path(tempfile.mkdtemp(prefix='vectory-access-edit-before-')).resolve()
process = log = None
report = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'passed': False,
          'classification': 'expected_defect_observation', 'correctness_acceptance': False,
          'server_sha256': sha(args.server), 'scope': __doc__, 'activation_claimed': False}

def stop():
    global process, log
    if process is not None and process.poll() is None:
        process.terminate()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=15)
    if log is not None: log.close(); log = None

try:
    binary = fixture/'server.exe'
    shutil.copyfile(args.server, binary)
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1', 0)); port = reserved.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    bootstrap = os.urandom(32).hex(); password = os.urandom(32).hex()
    (fixture/'bootstrap').write_text(bootstrap, encoding='ascii')
    env = {k:v for k,v in os.environ.items() if not k.upper().startswith('VECTORY_')
           and k.upper() not in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY')}
    env.update(VECTORY_DATA_DIR=str(fixture/'state'),VECTORY_HTTP_ADDR=f'127.0.0.1:{port}',
               VECTORY_DEVELOPMENT='true',VECTORY_COOKIE_SECURE='false',
               VECTORY_BOOTSTRAP_SECRET_FILE=str(fixture/'bootstrap'),
               VECTORY_DASHBOARD_DIR=str(fixture),VECTORY_RELEASES_DIR=str(fixture/'releases'))
    database = fixture/'state/vectory.db'
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(jar))
    csrf = ''
    def api(path,body=None,expected=200,method=None):
        request=urllib.request.Request(origin+'/api/v1'+path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type':'application/json','X-CSRF-Token':csrf},method=method)
        try: response=opener.open(request,timeout=15)
        except urllib.error.HTTPError as error: response=error
        with response: status=response.status; value=json.load(response)
        assert status==expected, f'{request.method} {path}: {status} != {expected}'
        return value
    def start():
        global process, log
        log=(fixture/'server.log').open('ab')
        process=subprocess.Popen([str(binary)],cwd=fixture,env=env,stdout=log,stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        for _ in range(150):
            try: api('/status'); return
            except (urllib.error.URLError, ConnectionError): time.sleep(.1)
        raise AssertionError('Private server startup timed out')
    def sql(query,values=()):
        with contextlib.closing(sqlite3.connect(database)) as conn:
            return conn.execute(query,values).fetchall()
    def wait_for_edit(target):
        for _ in range(200):
            rows=sql('SELECT name,role,revision FROM users WHERE id=?',(target,))
            if rows==[('Renamed colleague','editor',2)]: return
            time.sleep(.025)
        raise AssertionError('Expected committed access edit did not appear')

    start()
    csrf=api('/bootstrap',{'bootstrap_secret':bootstrap,'name':'Synthetic administrator',
        'email':'admin@example.invalid','password':password})['csrf_token']
    user=api('/users',{'name':'Synthetic colleague','email':'colleague@example.invalid',
        'password':password,'role':'viewer','current_password':password})
    target=user['id']; path=f'/users/{target}'
    request=urllib.request.Request(origin+'/api/v1'+path)
    jar.add_cookie_header(request)
    headers={'Content-Type':'application/json','X-CSRF-Token':csrf,
             'Cookie':request.get_header('Cookie')}
    lost=http.client.HTTPConnection('127.0.0.1',port,timeout=15)
    lost.request('PUT','/api/v1'+path,
        body=json.dumps({'name':'Renamed colleague','role':'editor','enabled':True,
                         'revision':1,'current_password':password}),headers=headers)
    wait_for_edit(target)
    lost.close()  # No response status, headers or body read.
    stop(); start()
    visible=next(person for person in api('/users') if person['id']==target)
    assert visible['name']=='Renamed colleague' and visible['role']=='editor' and visible['revision']==2
    status_path=f'{path}/access-requests/{uuid.uuid4()}'
    status_request=urllib.request.Request(origin+'/api/v1'+status_path)
    try: opener.open(status_request,timeout=15)
    except urllib.error.HTTPError as error: assert error.code==404
    else: raise AssertionError('An exact access-edit status route unexpectedly exists')
    replay=api(path,{'name':'Renamed colleague','role':'editor','enabled':True,
        'revision':1,'current_password':password},expected=409,method='PUT')
    assert replay['error']['code']=='STALE_REVISION'
    assert sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='user.update'")[0][0]==1
    assert sql("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='access_edit_requests'")[0][0]==0
    report.update(passed=True,groups=1,unread_committed_reply=True,
        restarted_same_datastore=True,exact_status_available=False,
        replay_conflicts_without_attribution=True,success_audits=1,
        target_revision=2,secret_in_evidence=False,
        source_sha256={name:sha(ROOT/name) for name in
            ['server/src/accounts.rs','server/src/api.rs','contracts/openapi.json']})
finally:
    stop()
    assert fixture.parent==Path(tempfile.gettempdir()).resolve() and fixture.name.startswith('vectory-access-edit-before-')
    shutil.rmtree(fixture)
    report['process_stopped']=process is None or process.poll() is not None
    report['private_fixture_removed']=not fixture.exists()
    report['harness_sha256']=sha(__file__)
    args.output.resolve().parent.mkdir(parents=True,exist_ok=True)
    args.output.resolve().write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({key:report[key] for key in
        ('passed','classification','server_sha256','process_stopped','private_fixture_removed')}))
