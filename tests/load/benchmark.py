#!/usr/bin/env python3
"""Isolated synthetic fleet benchmark over real mTLS, never an ordinary fleet.

Fixtures directly register CA-signed identities in a fresh SQLite database before
measurement. This excludes token enrollment throughput and native agent/Vector
activation. Each simulated agent has a unique key/certificate, private connection
pool, signed-nonce checks, 60-second heartbeat and declared jitter/telemetry.
"""
import argparse
import asyncio
import base64
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.local/load-deps'))
import aiohttp
import cryptography
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
import psutil


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def protected(path, data):
    path.write_bytes(data)
    path.chmod(0o600)


def pki(directory):
    import ipaddress
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'isolated synthetic benchmark CA')])
    start = datetime.now(timezone.utc) - timedelta(minutes=1)
    ca = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(start).not_valid_after(start+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True).sign(key, hashes.SHA256())
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'isolated benchmark server')])
    leaf = x509.CertificateBuilder().subject_name(leaf_name).issuer_name(name).public_key(leaf_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(start).not_valid_after(start+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False).sign(key, hashes.SHA256())
    protected(directory / 'server-ca.pem', ca.public_bytes(serialization.Encoding.PEM))
    protected(directory / 'server.pem', leaf.public_bytes(serialization.Encoding.PEM))
    protected(directory / 'server-key.pem', leaf_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


async def wait_ready(url, process):
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=1)) as client:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError('server exited before readiness')
            try:
                async with client.get(url+'/api/v1/status') as response:
                    if response.status == 200:
                        return
            except (aiohttp.ClientError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(0.1)
    raise RuntimeError('server readiness timed out')


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def seed(directory, count):
    state = directory / 'state'
    ca = x509.load_pem_x509_certificate((state / 'keys/device-ca.pem').read_bytes())
    ca_key = serialization.load_pem_private_key((state / 'keys/device-ca-key.pem').read_bytes(), password=None)
    signing = ed25519.Ed25519PrivateKey.from_private_bytes((state / 'keys/manifest-signing.key').read_bytes()).public_key()
    start = datetime.now(timezone.utc) - timedelta(minutes=1)
    identities = []
    pipeline = {'sources': {'synthetic': {'type': 'demo_logs', 'format': 'json', 'interval': 10}}, 'transforms': {'tag': {'type': 'remap', 'inputs': ['synthetic'], 'source': '.benchmark = true\n# ' + 'x'*850}}, 'sinks': {'discard': {'type': 'blackhole', 'inputs': ['tag']}}}
    artifact = json.dumps(pipeline, indent=2, sort_keys=True)+'\n'
    digest = hashlib.sha256(artifact.encode()).hexdigest()
    with closing(sqlite3.connect(state / 'vectory.db')) as db:
        db.execute('PRAGMA foreign_keys=ON')
        version = {'id': 'synthetic-version', 'configuration_id': 'synthetic-config', 'number': 1, 'artifact': artifact, 'sha256': digest, 'size': len(artifact.encode()), 'created_at': now()}
        db.execute('INSERT INTO records(kind,id,data,created_at) VALUES(?,?,?,?)', ('version', version['id'], json.dumps(version), now()))
        for i in range(count):
            device_id = str(uuid.uuid4())
            key = ec.generate_private_key(ec.SECP256R1())
            cert = x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, device_id)])).issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(start).not_valid_after(start+timedelta(days=1)).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False).sign(ca_key, hashes.SHA256())
            cert_file, key_file = directory / f'device-{i}.pem', directory / f'device-{i}-key.pem'
            protected(cert_file, cert.public_bytes(serialization.Encoding.PEM))
            protected(key_file, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            device = {'id': device_id, 'name': f'synthetic-load-{i}', 'os': 'simulated', 'arch': 'simulated', 'agent_version': 'synthetic-benchmark', 'vector_version': '0.58.0', 'last_seen': None, 'status': 'offline', 'labels': {}, 'reported_generation': 0, 'actual_sha256': None, 'apply_state': 'desired', 'sync_paused': False, 'pause_acknowledged': False, 'telemetry': None, 'created_at': now()}
            db.execute('INSERT INTO devices(id,name,data,desired_version_id,desired_generation) VALUES(?,?,?,?,1)', (device_id, device['name'], json.dumps(device), version['id']))
            db.execute('INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)', (hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest(), device_id, (start+timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ')))
            identities.append((device_id, cert_file, key_file))
        db.commit()
    return identities, signing, digest, len(artifact.encode())


def percentile(values, p):
    if not values:
        return None
    values = sorted(values)
    return round(values[min(len(values)-1, int((len(values)-1)*p))], 3)


async def scenario(args, count, binary):
    directory = args.out / str(count)
    directory.mkdir(mode=0o700)
    pki(directory)
    protected(directory / 'bootstrap', os.urandom(32).hex().encode())
    http_port, tls_port = free_port(), free_port()
    env = {**os.environ, 'VECTORY_DATA_DIR': str(directory/'state'), 'VECTORY_HTTP_ADDR': f'127.0.0.1:{http_port}', 'VECTORY_AGENT_ADDR': f'127.0.0.1:{tls_port}', 'VECTORY_TLS_CERT': str(directory/'server.pem'), 'VECTORY_TLS_KEY': str(directory/'server-key.pem'), 'VECTORY_BOOTSTRAP_SECRET_FILE': str(directory/'bootstrap'), 'VECTORY_DEVELOPMENT': 'true', 'VECTORY_COOKIE_SECURE': 'false', 'VECTORY_DASHBOARD_DIR': str(directory), 'VECTORY_RELEASES_DIR': str(directory/'releases')}
    env.pop('VECTORY_VALIDATION_URL', None)
    with (directory / 'server.log').open('wb') as log:
        process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            await wait_ready(f'http://127.0.0.1:{http_port}', process)
        finally:
            stop(process)
        identities, signing, digest, config_size = seed(directory, count)
        # Blocking filesystem/OpenSSL work must finish before measurement. Doing
        # this inside coroutines starves the event loop at large fleet sizes.
        context_started = time.perf_counter()
        def prepare_context(identity):
            _, cert_file, key_file = identity
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.minimum_version = ssl.TLSVersion.TLSv1_3
            context.set_alpn_protocols(['http/1.1'])
            context.load_verify_locations(cafile=str(directory/'server-ca.pem'))
            context.load_cert_chain(str(cert_file), str(key_file))
            return context
        with ThreadPoolExecutor(max_workers=8) as preparation:
            contexts = list(preparation.map(prepare_context, identities))
        context_setup_seconds = time.perf_counter()-context_started
        print(f'{count}: isolated signed identities provisioned; measuring {args.duration}s', flush=True)
        process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            await wait_ready(f'http://127.0.0.1:{http_port}', process)
            observed = psutil.Process(process.pid)
            observed.cpu_percent(None)
            cpu_start = observed.cpu_times()
            started = time.perf_counter()
            deadline = started + args.duration
            durations, success_durations, errors, received, convergence, samples = [], [], {}, set(), [], []
            totals = {'requests': 0, 'success': 0, 'request_bytes': 0, 'response_bytes': 0}
            attempted_identities = set()
            db_before = sum(p.stat().st_size for p in (directory/'state').glob('vectory.db*'))

            def observe():
                    values = {'t': round(time.perf_counter()-started, 2), 'cpu_percent_one_core': observed.cpu_percent(None), 'rss_bytes': observed.memory_info().rss, 'database_bytes': (directory/'state/vectory.db').stat().st_size, 'wal_bytes': (directory/'state/vectory.db-wal').stat().st_size if (directory/'state/vectory.db-wal').exists() else 0}
                    try:
                        values['server_tcp_connections'] = len(observed.net_connections(kind='tcp'))
                    except psutil.Error:
                        values['server_tcp_connections'] = None
                    values['collection_seconds'] = round(time.perf_counter()-started-values['t'],3)
                    return values

            async def monitor():
                due = started
                while time.perf_counter() < deadline:
                    lag = max(0,time.perf_counter()-due)
                    # Windows connection enumeration may block for seconds; it
                    # must not block client TLS timeouts or simulate server lag.
                    values = await asyncio.to_thread(observe)
                    values['client_event_loop_lag_ms'] = round(lag*1000,3)
                    samples.append(values)
                    due = time.perf_counter()+1
                    await asyncio.sleep(1)

            async def device(index, identity):
                device_id, cert_file, key_file = identity
                rng = random.Random(20260926+index)
                await asyncio.sleep(rng.uniform(0, args.interval))
                if time.perf_counter() >= deadline:
                    return
                context = contexts[index]
                # Match the agent's default pooled idle timeout; do not hide the server connection cap.
                connector = aiohttp.TCPConnector(ssl=context, limit=2, keepalive_timeout=90)
                async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=30)) as client:
                    failures = 0
                    while time.perf_counter() < deadline:
                        nonce = base64.b64encode(os.urandom(32)).decode()
                        payload = {'protocol_version': 1, 'request_id': uuid.uuid4().hex, 'nonce': nonce, 'boot_id': f'synthetic-{index}', 'agent_version': 'synthetic-benchmark', 'vector_version': '0.58.0', 'reported_generation': 1, 'policy_generation': 0, 'actual_sha256': digest, 'apply_state': 'verified_applied', 'local_paused': False, 'remote_pause_acknowledged': False, 'telemetry': {'sampled_at': now(), 'events_per_second': 12.5, 'errors': 0}}
                        body = json.dumps(payload).encode()
                        totals['requests'] += 1
                        attempted_identities.add(device_id)
                        totals['request_bytes'] += len(body)
                        request_started = time.perf_counter()
                        succeeded = False
                        try:
                            async with client.post(f'https://127.0.0.1:{tls_port}/agent/v1/heartbeat', data=body, headers={'Content-Type': 'application/json'}) as response:
                                raw = await response.read()
                                totals['response_bytes'] += len(raw)
                                if response.status != 200:
                                    errors[f'HTTP {response.status}'] = errors.get(f'HTTP {response.status}', 0)+1
                                else:
                                    envelope = json.loads(raw)
                                    manifest_bytes = base64.b64decode(envelope['payload'])
                                    signing.verify(base64.b64decode(envelope['signature']), manifest_bytes)
                                    manifest = json.loads(manifest_bytes)
                                    if manifest['device_id'] != device_id or manifest['nonce'] != nonce or manifest['generation'] != 1 or manifest['desired']['sha256'] != digest:
                                        raise ValueError('manifest binding mismatch')
                                    totals['success'] += 1
                                    succeeded = True
                                    if device_id not in received:
                                        received.add(device_id)
                                        convergence.append(time.perf_counter()-started)
                        except Exception as exc:
                            name = type(exc).__name__
                            if not errors:
                                print(f'{count}: first request failure: {exc}', flush=True)
                            errors[name] = errors.get(name, 0)+1
                        durations.append((time.perf_counter()-request_started)*1000)
                        if succeeded:
                            success_durations.append(durations[-1])
                        # Failed requests use bounded backoff, successful clients their interval + jitter.
                        failures = 0 if succeeded else failures+1
                        next_delay = (args.interval if succeeded else min(300, 5*(2**min(failures,6))))*rng.uniform(.8,1.2)
                        await asyncio.sleep(min(next_delay, max(0, deadline-time.perf_counter())))

            await asyncio.gather(monitor(), *(device(index, identity) for index, identity in enumerate(identities)))
            elapsed = time.perf_counter()-started
            cpu_end = observed.cpu_times()
            cpu_seconds = cpu_end.user+cpu_end.system-cpu_start.user-cpu_start.system
            with closing(sqlite3.connect(directory/'state/vectory.db', timeout=10)) as db:
                page_size = db.execute('PRAGMA page_size').fetchone()[0]
                page_count = db.execute('PRAGMA page_count').fetchone()[0]
                telemetry_rows = db.execute('SELECT count(*) FROM telemetry').fetchone()[0]
            log.flush()
            report = {'agents': count, 'duration_requested_seconds': args.duration, 'context_setup_outside_measurement_seconds': round(context_setup_seconds,3), 'unique_agents_attempted': len(attempted_identities), 'latency_successful_requests_ms': {'p50':percentile(success_durations,.5),'p95':percentile(success_durations,.95),'p99':percentile(success_durations,.99)}, 'max_client_event_loop_lag_ms':max(s['client_event_loop_lag_ms'] for s in samples), 'elapsed_seconds': round(elapsed,3), 'heartbeat_seconds': args.interval, 'initial_jitter_seconds': [0,args.interval], 'repeat_jitter_factor': [.8,1.2], 'connection_idle_timeout_seconds': 90, 'telemetry_json_bytes': len(json.dumps({'sampled_at':now(),'events_per_second':12.5,'errors':0}).encode()), 'configuration_bytes': config_size, 'configuration_churn': 0, 'artifact_downloads': 0, 'scope': 'real mTLS signed-manifest steady heartbeat simulation; seeded enrollment/desired state; no real apply or rollout measurement', **totals, 'errors': errors, 'error_rate': round((totals['requests']-totals['success'])/max(1,totals['requests']),6), 'latency_all_requests_ms': {'p50':percentile(durations,.5),'p95':percentile(durations,.95),'p99':percentile(durations,.99),'max':round(max(durations),3) if durations else None}, 'unique_agents_succeeded': len(received), 'signed_manifest_convergence_seconds': {'p50':percentile(convergence,.5),'p95':percentile(convergence,.95),'max':round(max(convergence),3) if convergence else None}, 'server_cpu_seconds':round(cpu_seconds,3), 'server_average_cpu_percent_one_core':round(cpu_seconds/elapsed*100,3), 'server_peak_sampled_cpu_percent_one_core':max(s['cpu_percent_one_core'] for s in samples), 'server_peak_rss_bytes':max(s['rss_bytes'] for s in samples), 'sqlite_bytes_before':db_before, 'sqlite_logical_bytes_after':page_size*page_count, 'sqlite_wal_peak_bytes':max(s['wal_bytes'] for s in samples), 'telemetry_rows_after':telemetry_rows, 'samples':samples}
            (directory/'result.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
            return report
        finally:
            stop(process)


async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--agents',type=int,nargs='+',default=[100,1000,10000])
    parser.add_argument('--duration',type=float,default=70)
    parser.add_argument('--interval',type=float,default=60)
    args=parser.parse_args()
    if any(count < 1 for count in args.agents) or args.duration <= 0 or args.interval <= 0:
        parser.error('agent counts, duration and interval must be positive')
    args.out=args.out.resolve()
    args.out.mkdir(parents=True,exist_ok=False)
    binary=args.out/args.server.name
    shutil.copyfile(args.server,binary)
    binary.chmod(0o700)
    hardware={'platform':platform.platform(),'processor':platform.processor(),'logical_cpus':psutil.cpu_count(),'physical_cpus':psutil.cpu_count(logical=False),'memory_total_bytes':psutil.virtual_memory().total,'python':platform.python_version(),'aiohttp':aiohttp.__version__,'cryptography':cryptography.__version__,'psutil':psutil.__version__,'server_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'build_profile':'debug (not release-optimized)','storage':str(args.out.anchor)+' local workspace volume; exact drive media not measured','measurement_notes':'client and server share this host; no network latency; synthetic isolated certificates; no advertised fleet capacity'}
    results=[]
    for count in args.agents:
        result=await scenario(args,count,binary)
        results.append(result)
        print(json.dumps({k:result[k] for k in ['agents','requests','success','error_rate','latency_all_requests_ms','unique_agents_succeeded','server_peak_rss_bytes','sqlite_wal_peak_bytes']}),flush=True)
        (args.out/'summary.json').write_text(json.dumps({'hardware':hardware,'results':results},indent=2)+'\n',encoding='utf-8')


if __name__=='__main__':
    if sys.platform=='win32':
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    asyncio.run(main())
