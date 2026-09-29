#!/usr/bin/env python3
"""Capacity run on one host: a real server, simulated devices, a rollout and churn.

The run provisions a private fixture directory, starts a copy of the given
server binary on loopback, seeds device identities offline (keys signed by the
server's own device CA, registered like enrollment would), and drives them
with tests/load/fleet (Go, one TLS connection pool per device). While the
devices check in, it creates an all-at-once deployment to all of them through
the dashboard API and enrolls new devices through the enrollment endpoint.
Heartbeat cadence steps down by phase to find where the server saturates.

It samples the server's CPU and memory from /proc, the database and WAL
sizes, the load generator's CPU and the whole host's CPU (other work on the
host shows up there), reads rollout progress from the database, and parses
the server's once-a-minute `vectory_server::sqlite` writer line.

Linux only. Needs Python 3.11+ with `cryptography`. The fixture directory holds
private keys: it is deleted afterwards unless --keep is given. The result
(--result) holds measurements only.

Simulated devices never run Vector: a "verified_applied" report is fixture
input, not activation evidence.
"""
import argparse
import base64
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import resource
import shutil
import signal
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ROOT = Path(__file__).resolve().parents[2]
TICK = os.sysconf('SC_CLK_TCK')


def iso(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def protected(path, data):
    path.write_bytes(data)
    path.chmod(0o600)


def pki(directory):
    """A private CA and a loopback server certificate for the agent listener."""
    import ipaddress
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'isolated capacity test CA')])
    start = datetime.now(timezone.utc) - timedelta(minutes=5)
    ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(start).not_valid_after(start + timedelta(days=1))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True).sign(key, hashes.SHA256()))
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'isolated capacity server')]))
            .issuer_name(name).public_key(leaf_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(start).not_valid_after(start + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False).sign(key, hashes.SHA256()))
    protected(directory / 'server-ca.pem', ca.public_bytes(serialization.Encoding.PEM))
    protected(directory / 'server.pem', leaf.public_bytes(serialization.Encoding.PEM))
    protected(directory / 'server-key.pem', leaf_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


def port_free(port):
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            return False
    return True


class Api:
    """The dashboard API as an administrator: session cookie plus CSRF token."""

    def __init__(self, base):
        self.base, self.cookie, self.csrf = base, '', ''

    def call(self, method, path, body=None, timeout=120):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header('content-type', 'application/json')
        if self.cookie:
            request.add_header('cookie', self.cookie)
        if self.csrf:
            request.add_header('x-csrf-token', self.csrf)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                cookie = response.headers.get('set-cookie')
                if cookie:
                    self.cookie = cookie.split(';')[0]
                return response.status, json.loads(response.read() or b'null')
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b'null')


def wait_ready(api, process, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('server exited before it was ready; see server.log')
        try:
            if api.call('GET', '/api/v1/status', timeout=2)[0] == 200:
                return
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError('server did not become ready')


def capped(megabytes):
    """A child's address-space limit, so an unbounded allocation fails in that
    process instead of pushing the whole host into swapless thrashing."""
    def apply():
        limit = megabytes * 2**20
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    return apply


def stop(process):
    if process.poll() is None:
        process.send_signal(signal.SIGINT)
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def seed(directory, count, vector_version):
    """Register `count` identities the way enrollment does, offline and fast."""
    keys = directory / 'state/keys'
    ca_pem = (keys / 'device-ca.pem').read_bytes()
    ca = x509.load_pem_x509_certificate(ca_pem)
    ca_id = hashlib.sha256(ca.public_bytes(serialization.Encoding.DER)).hexdigest()
    ca_key = serialization.load_pem_private_key((keys / 'device-ca-key.pem').read_bytes(), password=None)
    signing = ed25519.Ed25519PrivateKey.from_private_bytes((keys / 'manifest-signing.key').read_bytes()).public_key()
    signing_raw = signing.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    signing_id = hashlib.sha256(signing_raw).hexdigest()
    start = datetime.now(timezone.utc) - timedelta(minutes=5)
    expires = start + timedelta(days=2)
    devices = []
    (directory / 'devices').mkdir(mode=0o700)
    with closing(sqlite3.connect(directory / 'state/vectory.db')) as db:
        db.execute('PRAGMA foreign_keys=ON')
        for i in range(count):
            device_id = str(uuid.uuid4())
            name = f'load-{i:05d}'
            key = ec.generate_private_key(ec.SECP256R1())
            cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, device_id)]))
                    .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
                    .not_valid_before(start).not_valid_after(expires)
                    .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
                    .sign(ca_key, hashes.SHA256()))
            cert_file, key_file = directory / f'devices/{i}.pem', directory / f'devices/{i}-key.pem'
            protected(cert_file, cert.public_bytes(serialization.Encoding.PEM))
            protected(key_file, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            record = {'id': device_id, 'name': name, 'os': 'linux', 'arch': 'amd64', 'agent_version': 'capacity-driver', 'vector_version': vector_version,
                      'configuration_mode': 'restricted', 'last_seen': None, 'status': 'unmanaged', 'labels': {'fixture': 'capacity'},
                      'desired_generation': 0, 'reported_generation': 0, 'actual_sha256': None, 'apply_state': 'unmanaged',
                      'sync_paused': False, 'pause_acknowledged': False, 'telemetry': None, 'created_at': iso(start)}
            db.execute('INSERT INTO devices(id,name,data) VALUES(?,?,?)', (device_id, name, json.dumps(record)))
            db.execute('INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id,ca_id) VALUES(?,?,?,?,?)',
                       (hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest(), device_id, iso(expires), signing_id, ca_id))
            devices.append({'id': device_id, 'certificate': str(cert_file), 'key': str(key_file)})
        db.commit()
    return devices, base64.b64encode(signing_raw).decode()


class Monitor(threading.Thread):
    """One sample a second from /proc: server, driver, host, database files."""

    def __init__(self, server_pid, state):
        super().__init__(daemon=True)
        self.server_pid, self.driver_pid, self.state = server_pid, None, state
        self.samples, self.done = [], threading.Event()

    @staticmethod
    def process_seconds(pid):
        try:
            fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
            return (int(fields[11]) + int(fields[12])) / TICK
        except (OSError, IndexError, ValueError):
            return None

    @staticmethod
    def rss(pid):
        try:
            for line in Path(f'/proc/{pid}/status').read_text().splitlines():
                if line.startswith('VmRSS:'):
                    return int(line.split()[1]) * 1024
        except OSError:
            return None

    @staticmethod
    def host():
        values = [int(v) for v in Path('/proc/stat').read_text().splitlines()[0].split()[1:]]
        idle = values[3] + values[4]
        return sum(values[:8]) - idle, sum(values[:8])

    def size(self, name):
        try:
            return (self.state / name).stat().st_size
        except OSError:
            return 0

    def run(self):
        previous = None
        while not self.done.is_set():
            now = time.time()
            busy, total = self.host()
            current = {'unix': now, 'server': self.process_seconds(self.server_pid), 'driver': self.process_seconds(self.driver_pid) if self.driver_pid else None, 'busy': busy, 'total': total}
            if previous:
                span = current['unix'] - previous['unix']
                sample = {'unix': round(now, 3), 'loadavg_1m': float(Path('/proc/loadavg').read_text().split()[0]),
                          'host_busy_cpus': round((busy - previous['busy']) / max(total - previous['total'], 1) * os.cpu_count(), 3),
                          'server_rss_bytes': self.rss(self.server_pid), 'database_bytes': self.size('vectory.db'), 'wal_bytes': self.size('vectory.db-wal')}
                for key in ('server', 'driver'):
                    if current[key] is not None and previous[key] is not None:
                        sample[f'{key}_cpus'] = round((current[key] - previous[key]) / span, 3)
                self.samples.append(sample)
            previous = current
            self.done.wait(1)


class Progress(threading.Thread):
    """Deployment target states, read from the database every two seconds."""

    def __init__(self, database, deployment):
        super().__init__(daemon=True)
        self.database, self.deployment, self.samples, self.done = database, deployment, [], threading.Event()

    def run(self):
        while not self.done.is_set():
            try:
                with closing(sqlite3.connect(f'file:{self.database}?mode=ro', uri=True, timeout=5)) as db:
                    states = dict(db.execute('SELECT state,count(*) FROM deployment_targets WHERE deployment_id=? GROUP BY state', (self.deployment,)).fetchall())
                    status = db.execute("SELECT json_extract(data,'$.status') FROM records WHERE kind='deployment' AND id=?", (self.deployment,)).fetchone()
                self.samples.append({'unix': round(time.time(), 3), 'states': states, 'status': status[0] if status else None})
                if status and status[0] == 'completed':
                    return
            except sqlite3.Error as error:
                self.samples.append({'unix': round(time.time(), 3), 'error': str(error)})
            self.done.wait(2)


def quantiles(values):
    if not values:
        return None
    values = sorted(values)
    pick = lambda q: round(values[int((len(values) - 1) * q)], 3)
    return {'p50': pick(.5), 'p95': pick(.95), 'p99': pick(.99), 'max': round(values[-1], 3)}


WRITER_LINE = re.compile(r'^(\S+)\s+DEBUG\s+vectory_server::sqlite: writer lock since the last report (.*)$')


def writer_lines(log):
    """The server's once-a-minute writer lines, with their end time."""
    lines = []
    for raw in re.sub(r'\x1b\[[0-9;]*m', '', log).splitlines():
        match = WRITER_LINE.match(raw.strip())
        if not match:
            continue
        fields = dict(part.split('=', 1) for part in match.group(2).split())
        entry = {'unix': datetime.fromisoformat(match.group(1).replace('Z', '+00:00')).timestamp()}
        entry.update({k: float(v) for k, v in fields.items()})
        lines.append(entry)
    return lines


def pipeline():
    config = {'sources': {'synthetic': {'type': 'demo_logs', 'format': 'json', 'interval': 10}},
              'transforms': {'tag': {'type': 'remap', 'inputs': ['synthetic'], 'source': '.capacity = true\n# ' + 'x' * 850}},
              'sinks': {'discard': {'type': 'blackhole', 'inputs': ['tag']}}}
    graph = {'nodes': [{'id': 'synthetic', 'type': 'source', 'position': {'x': 0, 'y': 0}, 'data': {'kind': 'sources', 'type': 'demo_logs'}},
                       {'id': 'tag', 'type': 'transform', 'position': {'x': 240, 'y': 0}, 'data': {'kind': 'transforms', 'type': 'remap'}},
                       {'id': 'discard', 'type': 'sink', 'position': {'x': 480, 'y': 0}, 'data': {'kind': 'sinks', 'type': 'blackhole'}}],
             'edges': [{'id': 'synthetic-tag', 'source': 'synthetic', 'target': 'tag'}, {'id': 'tag-discard', 'source': 'tag', 'target': 'discard'}]}
    return config, graph


def analyze_database(path):
    """Row counts, integrity and the telemetry table's exact storage."""
    with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as db:
        counts = {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in ['devices', 'credentials', 'telemetry', 'deployment_targets', 'desired_artifacts', 'artifact_blobs', 'enrollments', 'records']}
        counts['audit'] = db.execute("SELECT count(*) FROM records WHERE kind='audit'").fetchone()[0]
        storage = {}
        for name, in db.execute("SELECT name FROM sqlite_master WHERE tbl_name='telemetry'"):
            pages, used = db.execute('SELECT count(*), sum(pgsize) FROM dbstat WHERE name=?', (name,)).fetchone()
            storage[name] = used or 0
        rows = counts['telemetry']
        data_bytes = db.execute('SELECT avg(length(data)), max(length(data)) FROM telemetry').fetchone()
        device_json = db.execute('SELECT avg(length(data)) FROM devices').fetchone()[0]
        return {
            'counts': counts,
            'quick_check': db.execute('PRAGMA quick_check').fetchone()[0],
            'page_size': db.execute('PRAGMA page_size').fetchone()[0],
            'logical_bytes': db.execute('PRAGMA page_size').fetchone()[0] * db.execute('PRAGMA page_count').fetchone()[0],
            'telemetry_storage_bytes': storage,
            'telemetry_bytes_per_row': round(sum(storage.values()) / rows, 1) if rows else None,
            'telemetry_json_bytes_mean_max': [round(data_bytes[0] or 0, 1), data_bytes[1]],
            'device_json_bytes_mean': round(device_json or 0, 1),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--server', type=Path, required=True, help='vectory-server binary (build with --release)')
    parser.add_argument('--driver', type=Path, required=True, help='go build -o DRIVER tests/load/fleet/main.go')
    parser.add_argument('--out', type=Path, required=True, help='new private fixture directory')
    parser.add_argument('--result', type=Path, required=True, help='where to write the measurement JSON')
    parser.add_argument('--devices', type=int, default=10000)
    parser.add_argument('--phases', default='steady-60:0:60,rate-30:360:30,rate-15:510:15,rate-10:660:10,rate-5:810:5', help='name:start-seconds:interval-seconds,...')
    parser.add_argument('--duration', type=float, default=960)
    parser.add_argument('--deploy-at', type=float, default=120, help='seconds into traffic; 0 skips the rollout')
    parser.add_argument('--enroll-per-minute', type=float, default=300)
    parser.add_argument('--components', type=int, default=3)
    parser.add_argument('--http-port', type=int, default=8390)
    parser.add_argument('--agent-port', type=int, default=8391)
    parser.add_argument('--build-profile', default='release')
    parser.add_argument('--server-memory-mb', type=int, default=4096, help='address-space limit for the server')
    parser.add_argument('--driver-memory-mb', type=int, default=4096, help='address-space limit for the load generator')
    parser.add_argument('--keep', action='store_true')
    args = parser.parse_args()
    phases = [{'name': n, 'at': float(a), 'interval': float(i)} for n, a, i in (p.split(':') for p in args.phases.split(','))]
    for port in (args.http_port, args.agent_port):
        if not port_free(port):
            parser.error(f'port {port} is in use')
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    binary, driver = out / 'vectory-server', out / 'capacity-driver'
    shutil.copyfile(args.server, binary)
    binary.chmod(0o700)
    shutil.copyfile(args.driver, driver)
    driver.chmod(0o700)
    pki(out)
    protected(out / 'bootstrap', os.urandom(32).hex().encode())
    state = out / 'state'
    env = {**os.environ, 'VECTORY_DATA_DIR': str(state), 'VECTORY_HTTP_ADDR': f'127.0.0.1:{args.http_port}', 'VECTORY_AGENT_ADDR': f'127.0.0.1:{args.agent_port}',
           'VECTORY_TLS_CERT': str(out / 'server.pem'), 'VECTORY_TLS_KEY': str(out / 'server-key.pem'), 'VECTORY_BOOTSTRAP_SECRET_FILE': str(out / 'bootstrap'),
           'VECTORY_DEVELOPMENT': 'true', 'VECTORY_COOKIE_SECURE': 'false', 'VECTORY_DASHBOARD_DIR': str(out), 'VECTORY_RELEASES_DIR': str(out / 'releases'),
           'RUST_LOG': 'vectory_server=info,vectory_server::sqlite=debug,tower_http=warn', 'NO_COLOR': '1'}
    env.pop('VECTORY_VALIDATION_URL', None)
    api = Api(f'http://127.0.0.1:{args.http_port}')
    log = (out / 'server.log').open('wb')
    result = {'date': iso(datetime.now(timezone.utc)), 'server_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'driver_sha256': hashlib.sha256(driver.read_bytes()).hexdigest(), 'build_profile': args.build_profile,
              'host': {'platform': platform.platform(), 'cpus': os.cpu_count(),
                       'cpu_model': next((l.split(':', 1)[1].strip() for l in Path('/proc/cpuinfo').read_text().splitlines() if l.startswith('model name')), None),
                       'memory_bytes': int(next(l for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemTotal')).split()[1]) * 1024,
                       'loadavg_before': Path('/proc/loadavg').read_text().split()[:3], 'python': platform.python_version()},
              'parameters': {'devices': args.devices, 'phases': phases, 'duration_seconds': args.duration, 'deploy_at_seconds': args.deploy_at,
                             'enroll_per_minute': args.enroll_per_minute, 'components_per_sample': args.components,
                             'server_memory_limit_mb': args.server_memory_mb, 'driver_memory_limit_mb': args.driver_memory_mb}}
    try:
        commit = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain', '--', 'server'], capture_output=True, text=True).stdout.strip()
        result['commit'], result['server_sources_modified'] = commit, bool(dirty)
    except OSError:
        pass
    # First start: migrations, keys and the administrator; then seed offline.
    account = {'email': 'capacity@example.test', 'password': os.urandom(16).hex()}
    process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log, preexec_fn=capped(args.server_memory_mb))
    try:
        wait_ready(api, process)
        status, body = api.call('POST', '/api/v1/bootstrap', {'bootstrap_secret': (out / 'bootstrap').read_text(), 'name': 'Capacity', **account})
        assert status == 200, body
        status, settings = api.call('GET', '/api/v1/settings')
        assert status == 200, settings
        vector_version = settings['vector_version']
    finally:
        stop(process)
    started = time.perf_counter()
    devices, signing_key = seed(out, args.devices, vector_version)
    result['seed_seconds'] = round(time.perf_counter() - started, 3)
    process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log, preexec_fn=capped(args.server_memory_mb))
    monitor = Monitor(process.pid, state)
    progress = None
    try:
        wait_ready(api, process)
        api.cookie = ''
        status, body = api.call('POST', '/api/v1/login', account)
        assert status == 200 and body.get('csrf_token'), body
        api.csrf = body['csrf_token']
        status, token = api.call('POST', '/api/v1/tokens', {'name': 'capacity churn', 'expires_hours': 4, 'max_uses': 100000, 'name_prefix': 'churn-', 'labels': {'fixture': 'capacity-churn'}})
        assert status == 200, token
        config, graph = pipeline()
        status, created = api.call('POST', '/api/v1/configurations', {'name': 'Capacity rollout', 'graph': graph, 'config': config})
        assert status == 200, created
        status, version = api.call('POST', f"/api/v1/configurations/{created['id']}/publish", {'revision': created['revision'], 'message': 'capacity'})
        assert status == 200, version
        result['artifact_bytes'] = version['size']
        plan = {'server': f'https://127.0.0.1:{args.agent_port}', 'ca': str(out / 'server-ca.pem'), 'signing_key': signing_key, 'vector_version': vector_version,
                'duration': args.duration, 'phases': phases, 'components': args.components, 'devices': devices,
                'enroll': {'token': token['token'], 'per_minute': args.enroll_per_minute, 'prefix': 'churn-', 'sources': [f'127.0.0.{n}' for n in range(2, 12)],
                           'start': 30, 'stop': max(31, args.duration - 30)} if args.enroll_per_minute > 0 else None}
        protected(out / 'plan.json', json.dumps(plan).encode())
        monitor.start()
        child = subprocess.Popen([str(driver), '--plan', str(out / 'plan.json'), '--out', str(out / 'driver.json')], stdout=subprocess.PIPE, stderr=(out / 'driver.log').open('wb'), text=True,
                                 env={**os.environ, 'GOMEMLIMIT': f'{args.driver_memory_mb // 2}MiB'}, preexec_fn=capped(args.driver_memory_mb))
        monitor.driver_pid = child.pid
        first = json.loads(child.stdout.readline())
        traffic = first['traffic_started_unix_ms'] / 1000
        result['driver_setup_seconds'] = first['setup_seconds']
        print(f'traffic started; setup {first["setup_seconds"]:.1f}s; running {args.duration:.0f}s', flush=True)
        if args.deploy_at > 0:
            time.sleep(max(0, traffic + args.deploy_at - time.time()))
            request = {'version_id': version['id'], 'priority': 10, 'target_mode': 'snapshot', 'selector': {'device_ids': [d['id'] for d in devices], 'group_ids': [], 'exclude_ids': []},
                       'rollout': {'kind': 'all', 'canary_size': 1, 'batch_size': 10000, 'observation_seconds': 0, 'failure_threshold': 0}}
            begin = time.time()
            status, deployment = api.call('POST', '/api/v1/deployments', request, timeout=300)
            result['deployment'] = {'created_unix': round(begin, 3), 'create_seconds': round(time.time() - begin, 3), 'status': status}
            assert status == 200, deployment
            print(f'deployment created in {time.time() - begin:.2f}s', flush=True)
            progress = Progress(state / 'vectory.db', deployment['id'])
            progress.start()
        child.wait(timeout=args.duration + 600)
        if child.returncode != 0:
            raise RuntimeError('driver failed; see driver.log')
    finally:
        monitor.done.set()
        if progress:
            progress.done.set()
        stop(process)
        log.close()
    report = json.loads((out / 'driver.json').read_text())
    server_log = (out / 'server.log').read_text(errors='replace')
    writer = writer_lines(server_log)
    try:
        result['database'] = analyze_database(state / 'vectory.db')
    except sqlite3.Error as error:
        result['database'] = {'error': str(error)}
    result['server_log'] = {'database_errors': server_log.count('database operation failed'), 'database_locked': server_log.count('database is locked'),
                            'error_lines': sum(1 for l in server_log.splitlines() if ' ERROR ' in l), 'warn_lines': sum(1 for l in server_log.splitlines() if ' WARN ' in l)}
    # Relative times: seconds since the driver started traffic.
    for sample in monitor.samples:
        sample['t'] = round(sample.pop('unix') - traffic, 1)
    for line in writer:
        line['t_end'] = round(line.pop('unix') - traffic, 1)
    phase_rows = []
    for i, p in enumerate(phases):
        start = p['at'] + p['interval']
        end = phases[i + 1]['at'] if i + 1 < len(phases) else args.duration
        window = [s for s in monitor.samples if start <= s['t'] < end]
        lines = [w for w in writer if w['t_end'] - w['window_seconds'] >= start - 1 and w['t_end'] <= end + 1]
        beats = report['heartbeats']['phases'].get(p['name'], {})
        mean = lambda key: round(sum(s.get(key) or 0 for s in window) / len(window), 3) if window else None
        phase_rows.append({'phase': p['name'], 'interval_seconds': p['interval'], 'settled_window': [start, end], 'heartbeats_per_second': beats.get('success_per_second'),
                           'latency_successful_ms': beats.get('latency_successful_ms'), 'requests': beats.get('requests'), 'success': beats.get('success'), 'errors': beats.get('errors'),
                           'server_cpus_mean': mean('server_cpus'), 'driver_cpus_mean': mean('driver_cpus'), 'host_busy_cpus_mean': mean('host_busy_cpus'),
                           'server_rss_max_bytes': max((s.get('server_rss_bytes') or 0 for s in window), default=None),
                           'loadavg_1m_mean': mean('loadavg_1m'), 'wal_bytes_max': max((s['wal_bytes'] for s in window), default=None),
                           'writer': [{k: w[k] for k in ('t_end', 'writes', 'busy_percent', 'wait_mean_ms', 'wait_max_ms', 'held_max_ms', 'wal_bytes')} for w in lines]})
    result['phases'] = phase_rows
    if progress:
        created = result['deployment']['created_unix']
        done = next((s for s in progress.samples if s.get('status') == 'completed'), None)
        rollout = report['rollouts'].get('1', {})
        seen = [t / 1000 - created for t in rollout.get('seen_unix_ms', [])]
        applied = [t / 1000 - created for t in rollout.get('applied_reported_unix_ms', [])]
        result['rollout'] = {'targets': args.devices, 'completed_after_seconds': round(done['unix'] - created, 1) if done else None,
                             'devices_saw_new_generation': len(seen), 'seen_after_seconds': quantiles(seen),
                             'devices_reported_applied': len(applied), 'applied_reported_after_seconds': quantiles(applied),
                             'progress': [{'t': round(s['unix'] - created, 1), **{k: v for k, v in s.items() if k != 'unix'}} for s in progress.samples]}
    result['driver'] = {k: v for k, v in report.items() if k != 'rollouts'}
    result['monitor_samples'] = monitor.samples
    result['writer_lines'] = writer
    args.result.write_text(json.dumps(result, indent=1) + '\n')
    for row in phase_rows:
        print(json.dumps({k: row[k] for k in ('phase', 'heartbeats_per_second', 'latency_successful_ms', 'errors', 'server_cpus_mean', 'host_busy_cpus_mean')}), flush=True)
    if 'rollout' in result:
        print(json.dumps({k: v for k, v in result['rollout'].items() if k != 'progress'}), flush=True)
    if not args.keep:
        shutil.rmtree(out)


if __name__ == '__main__':
    main()
