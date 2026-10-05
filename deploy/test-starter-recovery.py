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
if operation in ('image', 'volume', 'load', 'tag'):
    sys.exit(0)
if operation == 'compose':
    if args == ['version']:
        sys.exit(0)
    for argument in args:
        if argument in ('config', 'logs', 'stop', 'ps'):
            sys.exit(0)
        if argument == 'exec':
            print('{"initialized":true}')
            sys.exit(0)
        if argument == 'up':
            if os.environ['STUB_KIND'] == 'preview':
                pki = volume / 'pki'
                chain = pki / 'agent-chain.pem'
                if not chain.is_file() or chain.read_bytes() != (pki / 'server.pem').read_bytes() + (pki / 'ca.pem').read_bytes():
                    refuse('preview served chain is missing or incomplete')
            elif not all((volume / part).is_file() for part in ('server_cert', 'server_key', 'bootstrap')):
                refuse('server retained setup is incomplete')
            sys.exit(0)
    refuse('unknown compose operation')
if operation == 'run':
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
            'compose.yaml': f'deploy/compose.{"preview" if kind == "preview" else "release"}.yaml',
            'README.md': f'deploy/{kind.upper()}-README.md',
            'LICENSE': 'LICENSE', 'NOTICE': 'NOTICE',
        }
        if kind == 'server':
            sources.update({'Caddyfile': 'deploy/Caddyfile', '.env.example': 'deploy/.env.release.example'})
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
        self.env = os.environ.copy()
        for variable in tuple(self.env):
            if variable.startswith('VECTORY_'):
                self.env.pop(variable)
        self.env.update({
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

    def run(self, failpoint=''):
        env = self.env.copy()
        env['STUB_FAILPOINT'] = failpoint
        return subprocess.run(
            ['/bin/bash', str(self.bundle / 'start.sh')], cwd=self.bundle,
            env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15,
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
