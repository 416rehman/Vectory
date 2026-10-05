"""Disposable native HTTP proof of lost administrator reset-code issuance.

The fixture is private. No actual service, account, or fleet is contacted. The
one-time code is never captured or included in the evidence output.
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
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
fixture = Path(tempfile.mkdtemp(prefix='vectory-reset-before-')).resolve()
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
    binary = fixture / 'server.exe'
    shutil.copyfile(args.server, binary)
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1', 0))
        port = reserved.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    bootstrap = os.urandom(32).hex()
    password = os.urandom(32).hex()
    (fixture / 'bootstrap').write_text(bootstrap, encoding='ascii')
    env = {k:v for k,v in os.environ.items() if not k.upper().startswith('VECTORY_') and k.upper() not in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY')}
    env.update(VECTORY_DATA_DIR=str(fixture / 'state'), VECTORY_HTTP_ADDR=f'127.0.0.1:{port}',
               VECTORY_DEVELOPMENT='true', VECTORY_COOKIE_SECURE='false',
               VECTORY_BOOTSTRAP_SECRET_FILE=str(fixture / 'bootstrap'),
               VECTORY_DASHBOARD_DIR=str(fixture), VECTORY_RELEASES_DIR=str(fixture / 'releases'))
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    csrf = ''

    def api(path, body=None, expected=200):
        request = urllib.request.Request(origin+'/api/v1'+path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type':'application/json','X-CSRF-Token':csrf})
        try: response = opener.open(request, timeout=15)
        except urllib.error.HTTPError as error: response = error
        with response: status = response.status; value = json.load(response)
        assert status == expected, f'{request.method} {path}: {status} != {expected}'
        return value

    def start():
        global process,log
        log = (fixture/'server.log').open('ab')
        process = subprocess.Popen([str(binary)], cwd=fixture, env=env,
            stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        for _ in range(150):
            try: api('/status'); return
            except (urllib.error.URLError, ConnectionError): time.sleep(.1)
        raise AssertionError('Private server startup timed out')

    database = fixture / 'state/vectory.db'
    def sql(query, values=()):
        with contextlib.closing(sqlite3.connect(database)) as conn:
            return conn.execute(query, values).fetchall()

    def wait_revision(target, wanted):
        for _ in range(200):
            rows = sql('SELECT revision FROM users WHERE id=?', (target,))
            if rows and rows[0][0] == wanted: return
            time.sleep(.025)
        raise AssertionError('Expected committed reset issuance did not appear')

    start()
    csrf = api('/bootstrap', {'bootstrap_secret':bootstrap,'name':'Synthetic administrator',
        'email':'admin@example.invalid','password':password})['csrf_token']
    user = api('/users', {'name':'Synthetic colleague','email':'colleague@example.invalid',
        'password':password,'role':'viewer','current_password':password})
    target = user['id']
    path = f'/users/{target}/password-reset'
    request = urllib.request.Request(origin+'/api/v1'+path)
    jar.add_cookie_header(request)
    headers = {'Content-Type':'application/json','X-CSRF-Token':csrf,
               'Cookie':request.get_header('Cookie')}
    lost = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
    lost.request('POST', '/api/v1'+path,
        body=json.dumps({'current_password':password,'revision':1}), headers=headers)
    wait_revision(target, 2)
    first_verifier = sql('SELECT verifier FROM password_reset_codes WHERE user_id=?', (target,))[0][0]
    lost.close()  # No response status, headers, or code body read.
    stop(); start()
    # There is no exact status or cancellation endpoint, so an administrator's
    # fresh issuance is the only available recovery and invalidates the lost code.
    second = api(path, {'current_password':password,'revision':2})
    assert len(second['code']) == 64
    second_verifier = sql('SELECT verifier FROM password_reset_codes WHERE user_id=?', (target,))[0][0]
    assert first_verifier != second_verifier
    assert sql('SELECT revision FROM users WHERE id=?', (target,))[0][0] == 3
    assert sql('SELECT count(*) FROM password_reset_codes WHERE user_id=?', (target,))[0][0] == 1
    audits = sql("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='user.password_reset.issue'")[0][0]
    assert audits == 2
    report.update(passed=True, groups=1, unread_committed_reply=True,
        restarted_same_datastore=True, first_code_unrecoverable=True,
        second_issue_invalidated_first=True, issuance_audits=audits,
        target_revision=3, active_reset_codes=1, one_time_code_in_evidence=False,
        source_sha256={name:sha(ROOT/name) for name in
            ['server/src/accounts.rs','server/src/api.rs','server/migrations/0005_account_lifecycle.sql']})
finally:
    stop()
    assert fixture.parent == Path(tempfile.gettempdir()).resolve() and fixture.name.startswith('vectory-reset-before-')
    shutil.rmtree(fixture)
    report['process_stopped'] = process is None or process.poll() is not None
    report['private_fixture_removed'] = not fixture.exists()
    report['harness_sha256'] = sha(__file__)
    args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
    args.output.resolve().write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({key:report[key] for key in ('passed','classification','server_sha256','process_stopped','private_fixture_removed')}))
