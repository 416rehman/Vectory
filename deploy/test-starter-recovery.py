#!/usr/bin/env python3
"""Exercise starter recovery with temporary bundles and no Docker/network access.

Run on Linux: python3 deploy/test-starter-recovery.py
Python's standard library creates PATH-first Docker, curl, helper and mv stubs.
The actual starter scripts, Bash, checksum checks and file operations run in a
private temporary directory. This checks shell recovery, not container health,
certificate cryptography or durable writes after power loss.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
IMAGE_NAMES = ('vectory-server-image.tar.gz', 'vectory-validator-image.tar.gz')
BOOTSTRAP = b'A' * 64 + b'\n'

# A single executable implements all four stubs. There is deliberately no
# fallback to a real Docker, curl or certificate helper for unknown commands.
STUB = r'''#!/usr/bin/python3
import json
import os
from pathlib import Path
import subprocess
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
volume = Path(os.environ['STUB_VOLUME'])
bundle = Path(os.environ['STUB_BUNDLE'])
point = os.environ.get('STUB_FAILPOINT', '')
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps({'tool': name, 'args': args}) + '\n')

def local(path):
    return path.replace('/var/lib/vectory', str(volume))

def refuse(message):
    print('starter test stub: ' + message, file=sys.stderr)
    sys.exit(89)

def helper(arguments):
    options = {}
    mode = 'generate'
    while arguments:
        arg = arguments.pop(0)
        if arg in ('--check', '--bootstrap-only'):
            mode = 'check' if arg == '--check' else 'bootstrap'
        elif arg in ('--out', '--bootstrap', '--server-cert', '--server-key', '--hostname', '--hosts', '--days'):
            if not arguments:
                refuse('missing helper argument')
            options[arg] = local(arguments.pop(0))
            if arg == '--server-cert':
                mode = 'server-check'
        else:
            refuse('unknown helper argument')
    if mode == 'server-check':
        if not all(Path(options[key]).is_file() for key in ('--server-cert', '--server-key')):
            sys.exit(1)
    elif mode == 'check':
        pki = Path(options['--out'])
        if not all((pki / key).is_file() for key in ('ca.pem', 'server.pem', 'server-key.pem')):
            sys.exit(1)
        if not Path(options['--bootstrap']).is_file():
            sys.exit(1)
    elif mode == 'bootstrap':
        target = Path(options['--bootstrap'])
        with target.open('xb') as output:
            output.write(b'A' * 64 + b'\n')
        target.chmod(0o600)
    else:
        pki = Path(options['--out'])
        pki.mkdir(mode=0o700)
        for key in ('ca.pem', 'ca-key.pem', 'server.pem', 'server-key.pem'):
            target = pki / key
            target.write_bytes(('retained fixture ' + key + '\n').encode())
            target.chmod(0o600)
        target = Path(options['--bootstrap'])
        with target.open('xb') as output:
            output.write(b'A' * 64 + b'\n')
        target.chmod(0o600)
        if point == 'after-preview-pki':
            sys.exit(91)
    sys.exit(0)

if name == 'curl':
    # Prove no real public internet request is possible, even on test failure.
    sys.exit(7)
if name == 'vectory-local-pki':
    helper(args)
if name == 'mv':
    destination = Path(args[-1])
    if point == 'before-env-commit' and destination == bundle / '.env':
        sys.exit(91)
    result = subprocess.run(['/usr/bin/mv', *args], check=False)
    if result.returncode:
        sys.exit(result.returncode)
    if point == 'after-first-cert' and destination == volume / 'server_cert':
        sys.exit(91)
    if point == 'after-bootstrap' and destination == volume / 'bootstrap':
        sys.exit(91)
    sys.exit(0)
if name != 'docker' or not args:
    refuse('unknown executable or empty command')
operation = args.pop(0)
if operation == 'info':
    if args:
        print('linux/x86_64')
    sys.exit(0)
if operation == 'image':
    if '--format' in args:
        print('sha256:' + 'f' * 64)
    sys.exit(0)
if operation == 'network':
    if args[0] != 'inspect' or '--format' not in args:
        refuse('unknown network operation')
    project = os.environ.get('VECTORY_PREVIEW_PROJECT', 'vectory-preview')
    print('|'.join(['a' * 64, 'false' if point == 'noninternal-network' else 'true',
                    'other-project' if point == 'wrong-network-owner' else project,
                    'validation', 'bridge']))
    sys.exit(0)
if operation == 'inspect':
    if '--format' not in args or args[-1] != 'b' * 64:
        refuse('unknown container inspection')
    template = args[args.index('--format') + 1]
    if '.Config.Labels' in template:
        project = os.environ.get('VECTORY_PREVIEW_PROJECT', 'vectory-preview')
        print('|'.join(['other-project' if point == 'wrong-worker-owner' else project,
                        'server' if point == 'wrong-worker-service' else 'validator',
                        'sha256:' + ('e' if point == 'wrong-worker-image' else 'f') * 64]))
    elif '.HostConfig.PortBindings' in template:
        print('1|published' if point == 'published-worker-port' else '0|')
    elif '.NetworkSettings.Networks' in template:
        address = os.environ.get('STUB_VALIDATOR_IP', '172.28.0.2')
        if point == 'malicious-worker-ip':
            address = '$(touch ' + str(bundle / 'must-not-execute') + ')'
        elif point == 'invalid-worker-ip':
            address = '172.28.0.300'
        elif point == 'loopback-worker-ip':
            address = '127.0.0.1'
        print('|'.join([('c' if point == 'wrong-worker-network' else 'a') * 64,
                        address, '2' if point == 'extra-worker-network' else '1']))
    else:
        refuse('unknown container inspection template')
    sys.exit(0)
if operation in ('volume', 'load', 'tag', 'pull'):
    sys.exit(0)
if operation == 'compose':
    if args == ['version']:
        sys.exit(0)
    if os.environ['STUB_KIND'] == 'preview':
        generated = ('VECTORY_PREVIEW_SERVER_IMAGE', 'VECTORY_PREVIEW_VALIDATOR_IMAGE',
                     'VECTORY_PREVIEW_WEB_PORT', 'VECTORY_PREVIEW_AGENT_PORT',
                     'VECTORY_PREVIEW_VALIDATION_URL', 'VECTORY_PREVIEW_NO_PROXY')
        if any(key in os.environ for key in generated):
            refuse('caller environment can override checked preview configuration')
        environment = dict(line.split('=', 1) for line in (bundle / '.preview.env').read_text().splitlines())
    else:
        generated = ('VECTORY_SERVER_IMAGE', 'VECTORY_VALIDATOR_IMAGE', 'VECTORY_HOSTNAME',
                     'VECTORY_BIND_IP', 'VECTORY_CERTIFICATE_MODE', 'VECTORY_PUBLIC_AGENT_DOWNLOADS',
                     'VECTORY_MAX_AGENT_CONNECTIONS', 'VECTORY_TELEMETRY_RETENTION_DAYS', 'VECTORY_RELEASES_DIRECTORY')
        if any(key in os.environ for key in generated):
            refuse('caller environment can override authenticated server configuration')
    if os.environ.get('STUB_COMPOSE_EXE') and any(arg in ('config', 'up') for arg in args):
        index = next(i for i, arg in enumerate(args) if arg in ('config', 'up'))
        result = subprocess.run([os.environ['STUB_COMPOSE_EXE'], 'compose', *args[:index], 'config', '--format', 'json'],
                                capture_output=True, text=True, check=False)
        if result.returncode:
            print(result.stderr, file=sys.stderr)
            sys.exit(result.returncode)
        Path(os.environ['STUB_COMPOSE_RESULT']).write_text(result.stdout)
    for argument in args:
        if argument in ('config', 'logs', 'stop'):
            sys.exit(0)
        if argument == 'ps':
            if '-q' in args and args[-1] == 'validator':
                if point != 'missing-worker':
                    print('b' * 64)
            sys.exit(0)
        if argument == 'exec':
            if args[-1].endswith('/health'):
                if point == 'unreachable-worker':
                    sys.exit(7)
                print(json.dumps({'status':'ok','vector_version':'0.59.0' if point == 'wrong-worker-version' else '0.58.0',
                                  'worker_protocol':20 if point == 'wrong-worker-protocol' else 2}))
            else:
                print('{"initialized":true}')
            sys.exit(0)
        if argument == 'up':
            if os.environ['STUB_KIND'] == 'preview':
                pki = volume / 'pki'
                chain = pki / 'agent-chain.pem'
                if not chain.is_file() or chain.read_bytes() != (pki / 'server.pem').read_bytes() + (pki / 'ca.pem').read_bytes():
                    refuse('preview served chain is missing or incomplete')
                if args[-1] == 'validator':
                    if point == 'validator-start-failed':
                        sys.exit(91)
                    if environment['VECTORY_PREVIEW_VALIDATION_URL'] != 'http://127.0.0.1:9':
                        refuse('initial validator phase did not fail closed')
                else:
                    ip = os.environ.get('STUB_VALIDATOR_IP', '172.28.0.2')
                    if environment['VECTORY_PREVIEW_VALIDATION_URL'] != 'http://' + ip + ':8081':
                        refuse('manager started with stale validator URL')
                    if environment['VECTORY_PREVIEW_NO_PROXY'] != 'localhost,127.0.0.1,::1,' + ip:
                        refuse('manager has no direct worker proxy exclusion')
            elif not all((volume / part).is_file() for part in ('server_cert', 'server_key', 'bootstrap')):
                refuse('server retained setup is incomplete')
            sys.exit(0)
    refuse('unknown compose operation')
if operation == 'run':
    # Proxy storage is independent of the server's certificate/bootstrap
    # volume. Model that boundary so initializing a proxy directory can never
    # silently modify the retained-secret snapshot this fixture protects.
    for argument in args:
        if argument.startswith('type=volume,'):
            fields = dict(part.split('=', 1) for part in argument.split(',') if '=' in part)
            for suffix in ('caddy_data', 'caddy_config'):
                if fields.get('src', '').endswith('_' + suffix):
                    volume = Path(os.environ['STUB_VOLUME']).parent / 'proxy-volumes' / suffix
                    volume.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        index = args.index('--entrypoint')
        entry = args[index + 1]
        command = args[index + 3:]
    except (ValueError, IndexError):
        refuse('missing container entrypoint')
    if entry == '/bin/sh' and len(command) == 2 and command[0] == '-c':
        text = local(command[1]).replace('/app/operations/vectory-local-pki', os.environ['STUB_HELPER'])
        sys.exit(subprocess.run(['/bin/bash', '-c', text], check=False).returncode)
    if entry == 'cat':
        for path in command:
            sys.stdout.buffer.write(Path(local(path)).read_bytes())
        sys.exit(0)
    if entry == '/app/operations/vectory-local-pki':
        helper(command)
    if entry == '/app/operations/vectory-server-pki':
        for part in ('server_cert', 'server_key'):
            target = volume / part
            if not target.exists():
                target.write_text('retained automatic certificate fixture ' + part)
        sys.exit(0)
    refuse('unknown container entrypoint')
refuse('unknown Docker operation')
'''


def write(path, contents, executable=False):
    path.write_text(contents, encoding='utf-8')
    path.chmod(0o700 if executable else 0o600)


class Fixture:
    def __init__(self, directory, kind):
        self.root = directory
        self.kind = kind
        self.bundle = directory / 'bundle'
        self.bundle.mkdir()
        self.volume = directory / 'volume'
        self.volume.mkdir()
        self.log = directory / 'commands.jsonl'
        self.log.touch()
        self.bin = directory / 'bin'
        self.bin.mkdir()
        for executable in ('docker', 'curl', 'mv', 'vectory-local-pki'):
            write(self.bin / executable, STUB.replace('#!/usr/bin/python3', '#!' + sys.executable, 1), executable=True)
        sources = {
            'start.sh': f'deploy/start-{kind}.sh',
            'release-images.sh': 'deploy/release-images.sh',
            'verify-release.sh': 'deploy/verify-release.sh',
            'prepare-offline.sh': 'deploy/prepare-offline.sh',
            'compose.yaml': f'deploy/compose.{"preview" if kind == "preview" else "release"}.yaml',
            'README.md': f'deploy/{kind.upper()}-README.md',
            'LICENSE': 'LICENSE', 'NOTICE': 'NOTICE',
        }
        if kind == 'server':
            sources.update({'Caddyfile': 'deploy/Caddyfile', '.env.example': 'deploy/.env.release.example',
                            'start-auto.sh': 'deploy/start-auto.sh', 'compose.auto.yaml': 'deploy/compose.auto.yaml',
                            'Caddyfile.auto': 'deploy/Caddyfile.auto'})
        # Normalize checkout CRLF to the LF that a Linux release build uses.
        for name, source in sources.items():
            write(self.bundle / name, (ROOT / source).read_text(encoding='utf-8'), executable=name == 'start.sh')
        write(self.bundle / 'VERSION', '0.1.0\n')
        write(self.bundle / 'SHA256SUMS', ''.join(
            hashlib.sha256((self.bundle / name).read_bytes()).hexdigest() + '  ' + name + '\n'
            for name in sorted([*sources, 'VERSION'])
        ))
        self.cache = self.bundle / '.cache'
        self.cache.mkdir()
        self.image_bytes = {name: ('synthetic archive ' + name).encode() for name in IMAGE_NAMES}
        for name, contents in self.image_bytes.items():
            (self.cache / name).write_bytes(contents)
        write(self.cache / 'release-SHA256SUMS', ''.join(
            hashlib.sha256(contents).hexdigest() + '  ' + name + '\n'
            for name, contents in self.image_bytes.items()
        ))
        shutil.copyfile(self.cache / 'release-SHA256SUMS', self.cache / 'SHA256SUMS')
        self.env = os.environ.copy()
        for variable in tuple(self.env):
            if variable.startswith('VECTORY_'):
                self.env.pop(variable)
        self.env.update({
            'VECTORY_UNSIGNED_CANDIDATE': 'true',
            'PATH': str(self.bin) + ':/usr/bin:/bin',
            'STUB_KIND': kind, 'STUB_VOLUME': str(self.volume),
            'STUB_BUNDLE': str(self.bundle), 'STUB_LOG': str(self.log),
            'STUB_HELPER': str(self.bin / 'vectory-local-pki'),
        })
        if kind == 'server':
            (directory / 'cert.pem').write_bytes(b'operator certificate\n')
            (directory / 'key.pem').write_bytes(b'operator key\n')
            self.env.update({
                'VECTORY_HOSTNAME': 'vectory.example.com',
                'VECTORY_BIND_IP': '127.0.0.1',
                'VECTORY_TLS_CERT_FILE': str(directory / 'cert.pem'),
                'VECTORY_TLS_KEY_FILE': str(directory / 'key.pem'),
            })

    def run(self, failpoint='', umask=-1, action=None):
        env = self.env.copy()
        env['STUB_FAILPOINT'] = failpoint
        return subprocess.run(
            ['/bin/bash', str(self.bundle / 'start.sh'), *([action] if action else [])], cwd=self.bundle,
            env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15,
            umask=umask,
        )

    def commands(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def clear_log(self):
        self.log.write_text('')

    def retained_files(self):
        return {str(path.relative_to(self.volume)): path.read_bytes()
                for path in self.volume.rglob('*') if path.is_file()}


@unittest.skipUnless(sys.platform.startswith('linux') and shutil.which('bash'), 'requires Linux and Bash')
class StarterRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='vectory-starter-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def fixture(self, kind, name='case'):
        directory = self.root / name
        directory.mkdir()
        return Fixture(directory, kind)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def assert_no_network(self, fixture):
        self.assertFalse(any(command['tool'] == 'curl' for command in fixture.commands()))

    def assert_no_start_or_load(self, fixture):
        for command in fixture.commands():
            if command['tool'] == 'docker':
                self.assertNotIn(command['args'][0], ('load', 'tag'))
                self.assertFalse(command['args'][0] == 'compose' and 'up' in command['args'])

    def assert_complete_server_env(self, fixture):
        digests = [hashlib.sha256(fixture.image_bytes[name]).hexdigest()[:16] for name in IMAGE_NAMES]
        expected = (
            'VECTORY_HOSTNAME=vectory.example.com\n'
            'VECTORY_BIND_IP=127.0.0.1\n'
            f'VECTORY_SERVER_IMAGE=vectory-preview-server:0.1.0-{digests[0]}\n'
            f'VECTORY_VALIDATOR_IMAGE=vectory-preview-validator:0.1.0-{digests[1]}\n'
        )
        self.assertEqual((fixture.bundle / '.env').read_text(), expected)

    def test_cached_preview_and_server_start_without_network(self):
        for kind in ('preview', 'server'):
            with self.subTest(kind=kind):
                fixture = self.fixture(kind, kind)
                self.assert_success(fixture.run())
                before = fixture.retained_files()
                fixture.clear_log()
                self.assert_success(fixture.run())
                self.assertEqual(before, fixture.retained_files())
                self.assert_no_network(fixture)
                if kind == 'server':
                    self.assert_complete_server_env(fixture)

    def test_server_private_umask_extraction_keeps_secrets_private_and_public_mount_readable(self):
        fixture = self.fixture('server')
        for name in ('cert.pem', 'key.pem'):
            (fixture.root / name).chmod(0o600)
        self.assertEqual((fixture.bundle / 'Caddyfile').stat().st_mode & 0o777, 0o600)
        self.assert_success(fixture.run(umask=0o077))
        self.assertEqual((fixture.bundle / 'Caddyfile').stat().st_mode & 0o777, 0o644)
        self.assertEqual((fixture.bundle / 'releases').stat().st_mode & 0o777, 0o755)
        for path in (fixture.root / 'cert.pem', fixture.root / 'key.pem',
                     fixture.volume / 'server_cert', fixture.volume / 'server_key',
                     fixture.volume / 'bootstrap', fixture.bundle / '.env'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, str(path))
        self.assert_no_network(fixture)

    def test_server_does_not_widen_existing_operator_mirror(self):
        fixture = self.fixture('server')
        mirror = fixture.bundle / 'releases'
        mirror.mkdir(mode=0o700)
        private = mirror / 'operator-note'
        write(private, 'retain these private operator bytes\n')
        self.assert_success(fixture.run(umask=0o077))
        self.assertEqual(mirror.stat().st_mode & 0o777, 0o700)
        self.assertEqual(private.stat().st_mode & 0o777, 0o600)
        self.assertEqual(private.read_text(), 'retain these private operator bytes\n')

    def test_automatic_proxy_initialization_preserves_secrets_and_refuses_marker_links(self):
        fixture = self.fixture('server')
        fixture.env.pop('VECTORY_TLS_CERT_FILE')
        fixture.env.pop('VECTORY_TLS_KEY_FILE')
        self.assert_success(fixture.run())
        before = fixture.retained_files()
        markers = [fixture.root / 'proxy-volumes' / part / '.vectory-initialized'
                   for part in ('caddy_data', 'caddy_config')]
        marker_bytes = [marker.read_bytes() for marker in markers]
        self.assertTrue(all(marker.stat().st_mode & 0o777 == 0o600 for marker in markers))
        self.assert_success(fixture.run())
        self.assertEqual(before, fixture.retained_files())
        self.assertEqual(marker_bytes, [marker.read_bytes() for marker in markers])
        markers[0].unlink()
        markers[0].symlink_to(fixture.volume / 'server_key')
        fixture.clear_log()
        self.assertNotEqual(fixture.run().returncode, 0)
        self.assertEqual(before, fixture.retained_files())
        self.assert_no_start_or_load(fixture)
        self.assert_no_network(fixture)

    def test_preview_retry_restores_chain_after_pki_generation(self):
        fixture = self.fixture('preview')
        self.assertEqual(fixture.run('after-preview-pki').returncode, 91)
        retained = fixture.retained_files()
        self.assertNotIn('pki/agent-chain.pem', retained)
        fixture.clear_log()
        self.assert_success(fixture.run())
        for path, contents in retained.items():
            self.assertEqual((fixture.volume / path).read_bytes(), contents)
        self.assertEqual((fixture.volume / 'pki/agent-chain.pem').read_bytes(),
                         retained['pki/server.pem'] + retained['pki/ca.pem'])
        self.assertFalse(any('--days' in command['args'] for command in fixture.commands()))
        self.assert_no_network(fixture)

    def test_preview_starts_only_owned_validator_before_manager_and_checks_from_manager(self):
        fixture = self.fixture('preview')
        fixture.env.update({'VECTORY_PREVIEW_VALIDATION_URL':'http://untrusted.example.invalid:8081',
                            'VECTORY_PREVIEW_NO_PROXY':'untrusted.example.invalid',
                            'VECTORY_PREVIEW_SERVER_IMAGE':'untrusted-server:stale',
                            'VECTORY_PREVIEW_VALIDATOR_IMAGE':'untrusted-worker:stale',
                            'VECTORY_PREVIEW_WEB_PORT':'18080',
                            'VECTORY_PREVIEW_AGENT_PORT':'18443'})
        self.assert_success(fixture.run())
        ups = [c['args'] for c in fixture.commands() if c['tool']=='docker' and c['args'][0]=='compose' and 'up' in c['args']]
        self.assertEqual(len(ups), 2)
        self.assertEqual(ups[0][-1], 'validator')
        self.assertIn('--no-deps', ups[0])
        self.assertNotEqual(ups[1][-1], 'validator')
        env = (fixture.bundle / '.preview.env').read_text()
        self.assertIn('VECTORY_PREVIEW_VALIDATION_URL=http://172.28.0.2:8081\n', env)
        self.assertIn('VECTORY_PREVIEW_NO_PROXY=localhost,127.0.0.1,::1,172.28.0.2\n', env)
        self.assertIn('VECTORY_PREVIEW_SERVER_IMAGE=vectory-preview-server:0.1.0-', env)
        self.assertIn('VECTORY_PREVIEW_VALIDATOR_IMAGE=vectory-preview-validator:0.1.0-', env)
        self.assertIn('VECTORY_PREVIEW_WEB_PORT=18080\n', env)
        self.assertIn('VECTORY_PREVIEW_AGENT_PORT=18443\n', env)
        health = [c['args'] for c in fixture.commands() if c['tool']=='docker' and 'exec' in c['args'] and c['args'][-1].endswith('/health')]
        self.assertEqual(len(health), 1)
        self.assertIn('server', health[0])
        self.assertIn('--noproxy', health[0])
        self.assertEqual(health[0][-1], 'http://172.28.0.2:8081/health')
        self.assert_no_network(fixture)

    def test_preview_stop_resume_reresolves_worker_ip_without_replacing_trust(self):
        fixture = self.fixture('preview')
        self.assert_success(fixture.run())
        retained = fixture.retained_files()
        self.assert_success(fixture.run(action='stop'))
        fixture.env['STUB_VALIDATOR_IP'] = '172.28.0.3'
        fixture.clear_log()
        self.assert_success(fixture.run())
        self.assertEqual(retained, fixture.retained_files())
        self.assertIn('VECTORY_PREVIEW_VALIDATION_URL=http://172.28.0.3:8081\n', (fixture.bundle / '.preview.env').read_text())
        self.assert_no_network(fixture)

    def test_preview_refuses_missing_wrong_or_unisolated_worker_before_manager_start(self):
        cases = ('validator-start-failed','missing-worker','wrong-worker-owner','wrong-worker-service',
                 'wrong-worker-image','published-worker-port','wrong-network-owner','noninternal-network','wrong-worker-network',
                 'extra-worker-network','malicious-worker-ip','invalid-worker-ip','loopback-worker-ip')
        for point in cases:
            with self.subTest(point=point):
                fixture = self.fixture('preview', point)
                result = fixture.run(point)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Open http://', result.stdout)
                self.assertFalse((fixture.bundle / 'must-not-execute').exists())
                ups = [c['args'] for c in fixture.commands() if c['tool']=='docker' and c['args'][0]=='compose' and 'up' in c['args']]
                self.assertEqual(len(ups), 1)
                self.assertEqual(ups[0][-1], 'validator')
                self.assert_no_network(fixture)

    def test_preview_refuses_unreachable_or_wrong_protocol_worker_without_reporting_success(self):
        for point in ('unreachable-worker','wrong-worker-version','wrong-worker-protocol'):
            with self.subTest(point=point):
                fixture = self.fixture('preview', point)
                result = fixture.run(point)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Open http://', result.stdout)
                self.assertNotIn(BOOTSTRAP.decode().strip(), result.stdout)
                self.assert_no_network(fixture)

    def test_server_recovers_each_commit_interruption(self):
        for point in ('after-first-cert', 'after-bootstrap', 'before-env-commit'):
            with self.subTest(failpoint=point):
                fixture = self.fixture('server', point)
                self.assertEqual(fixture.run(point).returncode, 91)
                self.assertTrue((fixture.bundle / '.setup.env').is_file())
                self.assertFalse((fixture.bundle / '.env').exists())
                cert = (fixture.volume / 'server_cert').read_bytes()
                key_path = fixture.volume / ('server_key.part' if point == 'after-first-cert' else 'server_key')
                key = key_path.read_bytes()
                bootstrap = (fixture.volume / 'bootstrap').read_bytes() if point != 'after-first-cert' else None
                if point == 'before-env-commit':
                    write(fixture.bundle / '.env.part', 'VECTORY_HOSTNAME=partial')
                fixture.clear_log()
                self.assert_success(fixture.run())
                self.assertEqual((fixture.volume / 'server_cert').read_bytes(), cert)
                self.assertEqual((fixture.volume / 'server_key').read_bytes(), key)
                if bootstrap is not None:
                    self.assertEqual((fixture.volume / 'bootstrap').read_bytes(), bootstrap)
                    self.assertFalse(any('--bootstrap-only' in command['args'] for command in fixture.commands()))
                self.assertEqual((fixture.volume / 'bootstrap').read_bytes(), BOOTSTRAP)
                self.assert_complete_server_env(fixture)
                self.assertFalse((fixture.bundle / '.env.part').exists())
                self.assertFalse((fixture.bundle / '.setup.env').exists())
                self.assert_no_network(fixture)

    def test_malformed_and_wrong_project_journals_preserve_retained_state(self):
        cases = ('unknown-setting', 'duplicate-setting', 'unsafe-hostname', 'wrong-project')
        for case in cases:
            with self.subTest(journal=case):
                fixture = self.fixture('server', case)
                self.assertEqual(fixture.run('after-first-cert').returncode, 91)
                journal = fixture.bundle / '.setup.env'
                text = journal.read_text()
                if case == 'unknown-setting':
                    text += 'UNKNOWN=value\n'
                elif case == 'duplicate-setting':
                    text += 'VECTORY_HOSTNAME=vectory.example.com\n'
                elif case == 'unsafe-hostname':
                    text = text.replace('vectory.example.com', '$(touch ' + str(self.root / 'executed') + ')')
                else:
                    text = text.replace('VECTORY_SETUP_PROJECT=vectory\n', 'VECTORY_SETUP_PROJECT=another-project\n')
                write(journal, text)
                before = fixture.retained_files()
                fixture.clear_log()
                self.assertNotEqual(fixture.run().returncode, 0)
                self.assertEqual(before, fixture.retained_files())
                self.assertEqual(journal.read_text(), text)
                self.assertFalse((self.root / 'executed').exists())
                self.assertFalse((fixture.bundle / '.env').exists())
                self.assert_no_start_or_load(fixture)
                self.assert_no_network(fixture)

    def test_established_state_without_env_or_journal_is_refused(self):
        fixture = self.fixture('server')
        self.assert_success(fixture.run())
        (fixture.bundle / '.env').unlink()
        before = fixture.retained_files()
        fixture.clear_log()
        result = fixture.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Restore its original .env', result.stderr)
        self.assertEqual(before, fixture.retained_files())
        self.assertFalse((fixture.bundle / '.setup.env').exists())
        self.assert_no_start_or_load(fixture)
        self.assert_no_network(fixture)

    def test_corrupt_cached_archive_is_never_loaded(self):
        fixture = self.fixture('preview')
        (fixture.cache / IMAGE_NAMES[0]).write_bytes(b'corrupt archive')
        self.assertNotEqual(fixture.run().returncode, 0)
        self.assert_no_start_or_load(fixture)
        self.assertFalse(fixture.retained_files())

    def test_malformed_cached_inventory_is_refused_without_network(self):
        fixture = self.fixture('preview')
        inventory = fixture.cache / 'release-SHA256SUMS'
        inventory.write_text(inventory.read_text() + inventory.read_text().splitlines()[0] + '\n')
        self.assertNotEqual(fixture.run().returncode, 0)
        self.assert_no_start_or_load(fixture)
        self.assert_no_network(fixture)
        self.assertFalse(fixture.retained_files())


if __name__ == '__main__':
    unittest.main(verbosity=2)
