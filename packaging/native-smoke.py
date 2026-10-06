#!/usr/bin/env python3
"""Real Ubuntu/systemd smoke gate for prebuilt native candidate or signed bytes.

Uses a fresh disposable CI host only. Creates one labeled synthetic account and
pipeline, tests native Vector/VRL and isolation, then stops the four services.
It never enrolls a device or reports a workload activated. Secret-bearing
startup output stays in private temporary files and is never published.
"""
import argparse
import errno
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import platform
import pwd
import secrets
import shutil
import ssl
import subprocess
import tempfile
import urllib.error
import urllib.request

UNITS = ['vectory-native-' + role + '.service' for role in ('validator', 'certificates', 'server', 'proxy')]


def run(*args, check=True, env=None, timeout=180):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=check, env=env, timeout=timeout)


def value(unit, property):
    return run('systemctl', 'show', unit, '--property', property, '--value').stdout.decode().strip()


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def smoke(kit, archive, out, release_dir=None, bootstrap_script=None):
    check(platform.system() == 'Linux' and platform.machine() == 'x86_64' and os.geteuid() == 0,
          'Native smoke requires root on a disposable Linux x86-64 systemd host')
    check(not Path('/etc/vectory-server').exists() and not Path('/var/lib/vectory-server').exists(),
          'Refusing to test against an existing native instance')
    kit = kit.resolve(strict=True)
    version = (kit / 'VERSION').read_text().strip()
    proof = json.loads((kit / 'NATIVE-PROVENANCE.json').read_text())
    verified = set()
    check(proof['version'] == version and proof['platform'] == 'linux-amd64-systemd', 'Prebuilt native payload identity mismatch')
    verified.add('prebuilt_identity')
    environment = os.environ.copy()
    environment.pop('VECTORY_NATIVE_CI_CANDIDATE', None)
    launcher = str(kit / 'start.sh')
    refused = run(launcher, 'start', '--candidate-root', str(kit), '--hostname', 'localhost',
                  '--tls-mode', 'local', check=False, env=environment)
    check(refused.returncode != 0 and not Path('/etc/vectory-server').exists(), 'Candidate consent guard did not refuse before installation')
    if bootstrap_script:
        check(release_dir is not None, 'Public bootstrap negative requires signed proof')
        with tempfile.TemporaryDirectory(prefix='vectory-native-invalid-proof-') as temporary:
            invalid = Path(temporary)
            (invalid / 'SHA256SUMS').write_bytes((release_dir / 'SHA256SUMS').read_bytes() + b'\n# deliberately tampered synthetic CI inventory\n')
            shutil.copyfile(release_dir / 'SHA256SUMS.sigstore.json', invalid / 'SHA256SUMS.sigstore.json')
            rejected = run('bash', str(bootstrap_script.resolve(strict=True)), '--hostname', 'localhost', '--tls-mode', 'local',
                '--release-dir', str(invalid), '--cosign-file', str(kit / 'bin/cosign'), check=False, env=environment, timeout=240)
            check(rejected.returncode != 0 and b'Release signature verification failed.' in rejected.stderr
                and not Path('/etc/vectory-server').exists(), 'Public bootstrap did not reject the changed inventory at its signature boundary')
    verified.add('preflight_guards')
    arguments = ['start', '--hostname', 'localhost', '--tls-mode', 'local']
    if release_dir:
        arguments += ['--release-dir', str(release_dir.resolve(strict=True))]
    else:
        environment['VECTORY_NATIVE_CI_CANDIDATE'] = 'true'
        arguments += ['--candidate-root', str(kit)]
    sentinel = Path('/etc/.vectory-native-ci-sentinel')
    check(not sentinel.exists(), 'CI filesystem sentinel already exists')
    sentinel.write_text('synthetic publicly readable host sentinel\n')
    sentinel.chmod(0o644)
    started = False
    try:
        with tempfile.TemporaryDirectory(prefix='vectory-native-private-log-') as temporary:
            log = Path(temporary) / 'startup.log'
            install_command = [launcher, *arguments]
            if bootstrap_script:
                check(release_dir is not None, 'Public bootstrap smoke requires actual signed release proof')
                install_command = ['bash', str(bootstrap_script.resolve(strict=True)), '--hostname', 'localhost', '--tls-mode', 'local',
                    '--release-dir', str(release_dir.resolve(strict=True)), '--cosign-file', str(kit / 'bin/cosign')]
            with log.open('wb') as private:
                outcome = subprocess.run(install_command, env=environment,
                    stdout=private, stderr=private, timeout=240)
            check(outcome.returncode == 0, 'Native startup failed; private startup output was not published')
            with log.open('rb') as private:
                startup_output = private.read(1024 * 1024 + 1)
            check(len(startup_output) <= 1024 * 1024, 'Native startup output exceeded its private-log bound')
            with Path('/var/lib/vectory-server/secrets/bootstrap').open('rb') as private:
                bootstrap_value = private.read(4097)
            check(len(bootstrap_value) <= 4096, 'Native setup secret exceeded its private fixture bound')
            bootstrap_secret = bootstrap_value.strip()
            del bootstrap_value
            check(32 <= len(bootstrap_secret) <= 4096
                and b'Create your first administrator using this setup secret:\n' + bootstrap_secret + b'\n' in startup_output,
                'Native first startup did not privately print its actual setup secret')
            secret_hint = f'sudo /opt/vectory-server/{version}/start.sh setup-secret'.encode()
            check(secret_hint in startup_output, 'Native startup did not print the installed absolute setup-secret command')
            del startup_output
        started = True
        worker = UNITS[0]
        pid = int(value(worker, 'MainPID'))
        check(pid > 0 and all(run('systemctl', 'is-active', '--quiet', unit, check=False).returncode == 0 for unit in UNITS),
              'Native services did not all become active')
        expected_properties = {'PrivateNetwork': 'yes', 'PrivateDevices': 'yes', 'NoNewPrivileges': 'yes',
            'ProtectSystem': 'strict', 'ProtectHome': 'yes', 'RestrictAddressFamilies': 'AF_UNIX',
            'CapabilityBoundingSet': '', 'KillMode': 'control-group'}
        for property, wanted in expected_properties.items():
            check(value(worker, property) == wanted, 'Missing worker safety property: ' + property)
        proc = Path('/proc') / str(pid)
        status = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
        worker_uid = pwd.getpwnam('vectory-validator').pw_uid
        check(set(status['Uid'].split()) == {str(worker_uid)} and worker_uid != 0, 'Worker is not running as its dedicated unprivileged account')
        check(all(int(status[key].strip(), 16) == 0 for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd')),
              'Running worker has retained capabilities')
        check(status['NoNewPrivs'].strip() == '1' and status['Seccomp'].strip() == '2', 'Running worker lacks kernel privilege/syscall restrictions')
        check(pwd.getpwnam('vectory-server').pw_uid != worker_uid and pwd.getpwnam('vectory-proxy').pw_uid != worker_uid,
              'Worker account is shared with another native role')
        verified.add('service_sandbox')
        check(os.readlink(proc / 'ns/net') != os.readlink('/proc/self/ns/net'), 'Worker shares the host network namespace')
        unreachable = run('nsenter', '--target', str(pid), '--net', '--', 'curl', '--noproxy', '*',
            '--silent', '--fail', '--max-time', '3', 'http://127.0.0.1:8080/api/v1/status', check=False)
        check(unreachable.returncode != 0, 'Worker network namespace can reach the host API')
        verified.add('network_namespace')
        installed = Path('/opt/vectory-server') / version
        check(os.readlink(proc / 'root') == str(installed / 'validator-root'), 'Actual worker root differs from the authenticated private payload')
        root = proc / 'root'
        check(not (root / 'etc/.vectory-native-ci-sentinel').exists() and not (root / 'etc/vectory-server').exists()
            and not (root / 'var/lib/vectory-server').exists() and not (root / 'var/run/docker.sock').exists(),
            'Host state, secrets or engine socket are visible inside the worker root')
        try:
            descriptor = os.open(root / 'usr/local/bin/vector-validator', os.O_WRONLY)
        except OSError as error:
            check(error.errno == errno.EROFS, 'Private worker payload is not protected by a read-only mount')
        else:
            os.close(descriptor)
            raise RuntimeError('Private worker payload permits writes')
        verified.add('private_filesystem')
        control_group = value(worker, 'ControlGroup')
        group = Path('/sys/fs/cgroup') / control_group.removeprefix('/')
        check((group / 'memory.max').read_text().strip() == '536870912'
            and (group / 'memory.swap.max').read_text().strip() == '0'
            and (group / 'pids.max').read_text().strip() == '64', 'Actual cgroup resource bounds are missing')
        quota, period = (group / 'cpu.max').read_text().split()
        check(quota != 'max' and 0 < int(quota) <= int(period), 'Actual worker CPU quota is missing')
        verified.add('resource_limits')
        socket = Path('/run/vectory-validator/validator.sock')
        check(socket.is_socket() and not socket.is_symlink() and socket.stat().st_uid == worker_uid
            and socket.stat().st_mode & 0o777 == 0o660, 'Worker socket ownership or mode is unsafe')
        def worker_call(path, payload=None):
            args = ['curl', '--fail', '--silent', '--show-error', '--max-time', '15', '--unix-socket', str(socket)]
            if payload is not None:
                args += ['--header', 'Content-Type: application/json', '--data', json.dumps(payload)]
            return json.loads(run(*args, 'http://validator' + path).stdout)
        health = worker_call('/health')
        check(health.get('vector_version') == '0.58.0' and health.get('worker_protocol') == 2, 'Native pinned Vector worker handshake mismatch')
        verified.add('worker_uds')
        sample = worker_call('/transform-test', {'transform': {'type': 'remap', 'source': '.checked = true'}, 'samples': [{'message': 'synthetic native CI sample'}]})
        check(sample.get('compiled') is True and sample.get('diagnostics') == [] and sample.get('results'),
              'Native Vector did not actually compile and execute the synthetic remap')
        check('"checked": true' in json.dumps(sample['results']), 'Native synthetic sample did not carry the expected remap output')
        verified.add('synthetic_transform')
        state = Path('/var/lib/vectory-server')
        ca = state / 'caddy-data/caddy/pki/authorities/local/root.crt'
        context = ssl.create_default_context(cafile=str(ca))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        def request(path, payload=None, csrf=None):
            headers = {'Content-Type': 'application/json', 'Origin': 'https://localhost'}
            if csrf:
                headers['X-CSRF-Token'] = csrf
            req = urllib.request.Request('https://localhost' + path,
                data=None if payload is None else json.dumps(payload).encode(), headers=headers)
            with opener.open(req, timeout=30) as response:
                return json.load(response)
        check(request('/api/v1/status')['initialized'] is False, 'Native browser HTTPS or initial setup failed')
        with opener.open('https://localhost/NOTICE.txt', timeout=10) as response:
            check(response.read() == (kit / 'NOTICE').read_bytes(), 'Native dashboard legal file differs from prebuilt bytes')
        verified.add('dashboard_https')
        agent_ca = state / 'secrets/issuer/agent-ca.pem'
        agent_context = ssl.create_default_context(cafile=str(agent_ca))
        import socket as sockets
        with sockets.create_connection(('localhost', 8443), timeout=10) as connection:
            with agent_context.wrap_socket(connection, server_hostname='localhost'):
                pass
        verified.add('agent_tls')
        refused = False
        try:
            with sockets.create_connection(('localhost', 8443), timeout=10) as connection:
                with context.wrap_socket(connection, server_hostname='localhost'):
                    pass
        except ssl.SSLCertVerificationError:
            refused = True
        check(refused, 'Unrelated browser CA was accepted by the private agent listener')
        verified.add('wrong_ca_rejected')
        session = request('/api/v1/bootstrap', {'name': 'Synthetic native CI administrator',
            'email': 'native-ci@example.invalid', 'password': secrets.token_urlsafe(32),
            'bootstrap_secret': (state / 'secrets/bootstrap').read_text().strip()})
        csrf = session['csrf_token']
        verified.add('bootstrap')
        config = {'sources': {'events': {'type': 'demo_logs', 'format': 'json'}},
                  'sinks': {'discard': {'type': 'blackhole', 'inputs': ['events']}}}
        created = request('/api/v1/configurations', {'name': 'Synthetic native CI pipeline',
            'description': 'Isolated validation only; never deployed', 'graph': {'nodes': [], 'edges': []}, 'config': config}, csrf)
        path = f"/api/v1/configurations/{created['id']}/validate"
        result = request(path, {'config': config}, csrf)
        check(result.get('valid') is True and result.get('vector_validated') is True and result.get('deferred') is False,
              'Native manager did not validate with its protected Vector worker')
        socket.chmod(0o666)
        try:
            try:
                unsafe = request(path, {'config': config}, csrf)
                check(unsafe.get('valid') is not True or unsafe.get('vector_validated') is not True,
                      'Native manager accepted an unsafe socket replacement')
            except urllib.error.HTTPError:
                pass
        finally:
            socket.chmod(0o660)
        check(request(path, {'config': config}, csrf).get('vector_validated') is True, 'Safe socket was not recovered deliberately')
        verified.add('vector_validation')
        trust = digest(agent_ca)
        run(launcher, 'stop', env=environment)
        with tempfile.TemporaryDirectory(prefix='vectory-native-private-log-') as temporary:
            log = Path(temporary) / 'restart.log'
            with log.open('wb') as private:
                outcome = subprocess.run([launcher, *arguments], env=environment,
                    stdout=private, stderr=private, timeout=240)
            check(outcome.returncode == 0, 'Native restart failed; private restart output was not published')
            with log.open('rb') as private:
                restart_output = private.read(1024 * 1024 + 1)
            check(len(restart_output) <= 1024 * 1024, 'Native restart output exceeded its private-log bound')
            check(bootstrap_secret not in restart_output and secret_hint in restart_output,
                  'Initialized native restart printed its secret or omitted the absolute operation hint')
            del restart_output
        check(digest(agent_ca) == trust and request('/api/v1/status')['initialized'] is True,
              'Native restart lost its first account or retained agent issuer')
        verified.add('restart_state_preserved')
    finally:
        if started or Path('/etc/vectory-server/instance.conf').exists():
            run(launcher, 'stop', env=environment, check=False)
        sentinel.unlink(missing_ok=True)
    check(all(run('systemctl', 'is-active', '--quiet', unit, check=False).returncode != 0 for unit in UNITS),
          'Native stop left a service active')
    verified.add('stop')
    evidence = {'passed': True, 'version': version, 'source_commit': proof['source_commit'],
        'archive_sha256': digest(archive), 'verified': sorted(verified),
        'authentication': 'actual tagged Sigstore proof' if release_dir else 'explicit unsigned candidate CI only',
        'scope': 'Actual prebuilt native install on a disposable Ubuntu systemd host, trusted localhost HTTPS, private agent TLS, native Vector validation and synthetic remap. No device enrolled or workload deployed.'}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Native prebuilt isolation and readiness gate passed; no device activation was claimed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kit', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--release-dir', type=Path)
    parser.add_argument('--bootstrap-script', type=Path)
    args = parser.parse_args()
    smoke(args.kit, args.archive, args.out, args.release_dir, args.bootstrap_script)
