"""Static native failure diagnostics fixtures; no native service execution."""
import importlib.util
from pathlib import Path
import platform
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('native_smoke_diagnostics', Path(__file__).with_name('native-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
# The smoke runner uses pwd on Linux; these portable fixtures call only its
# platform-independent diagnostic parser and private-file error handling.
with mock.patch.dict(sys.modules, {} if importlib.util.find_spec('pwd') else {'pwd': mock.Mock()}):
    spec.loader.exec_module(smoke)


def marker(phase='host_preflight', status=1, line=40):
    return f'VECTORY_NATIVE_FAILURE phase={phase} status={status} line={line}'.encode()


class NativeSmokeDiagnosticsTests(unittest.TestCase):
    def test_every_predeclared_phase_returns_only_bounded_static_fields(self):
        for phase in smoke.FAILURE_PHASES:
            with self.subTest(phase=phase):
                private = b'synthetic private secret\n' + marker(phase=phase) + b'\nunpublished diagnostic text\n'
                self.assertEqual(smoke.native_failure_marker(private, 400, 1),
                                 {'phase': phase, 'status': 1, 'line': 40})
        self.assertEqual(smoke.native_failure_marker(marker(status=255, line=400), 400, 255),
                         {'phase': 'host_preflight', 'status': 255, 'line': 400})

    def test_unknown_duplicate_malformed_and_out_of_range_markers_are_refused(self):
        attacks = (b'', b'synthetic private text', marker(phase='unknown'), marker(phase='outside/path'),
                   marker(status=0), marker(status=256), marker(status=-1), marker(status=2),
                   marker(line=0), marker(line=-1), marker(line=401), marker(line='040'),
                   marker(status='01'), marker() + b' secret=synthetic', b'prefix ' + marker(),
                   marker() + b'\n' + marker(), marker() + b'\nVECTORY_NATIVE_FAILURE malformed',
                   marker() + b'\n' + b'x' * smoke.PRIVATE_LOG_LIMIT)
        for data in attacks:
            with self.subTest(data=data[:100]):
                self.assertIsNone(smoke.native_failure_marker(data, 400, 1))
        for lines, status in ((0, 1), (True, 1), (65537, 1), (400, True), (400, -9)):
            self.assertIsNone(smoke.native_failure_marker(marker(), lines, status))

    def test_failure_report_never_contains_private_log_text_or_file_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log, launcher = root / 'private.log', root / 'launcher.sh'
            launcher.write_bytes(b'fixed launcher source line\n' * 80)
            log.write_bytes(b'synthetic-private-secret\n' + marker() + b'\nsynthetic-private-path\n')
            with self.assertRaises(RuntimeError) as result:
                smoke.check_native_start(subprocess.CompletedProcess([], 1), log, launcher, 'startup')
            self.assertEqual(str(result.exception), 'Native startup failed at phase=host_preflight line=40 status=1; private output was not published')
            self.assertNotIn('synthetic-private', str(result.exception))
            self.assertNotIn(str(root), str(result.exception))
            with self.assertRaises(RuntimeError) as unknown_operation:
                smoke.check_native_start(subprocess.CompletedProcess([], 1), log, launcher, 'synthetic-private-operation')
            self.assertNotIn('synthetic-private-operation', str(unknown_operation.exception))
            for data in (marker(line=81), marker() + b'\n' + marker(), marker() + b'x' * smoke.PRIVATE_LOG_LIMIT):
                log.write_bytes(data)
                with self.assertRaises(RuntimeError) as fallback:
                    smoke.check_native_start(subprocess.CompletedProcess([], 1), log, launcher, 'restart')
                self.assertEqual(str(fallback.exception), 'Native restart failed; private output was not published')
            launcher.write_bytes(b'x' * 65537)
            log.write_bytes(marker())
            with self.assertRaises(RuntimeError) as fallback:
                smoke.check_native_start(subprocess.CompletedProcess([], 1), log, launcher, 'startup')
            self.assertEqual(str(fallback.exception), 'Native startup failed; private output was not published')

    def test_success_does_not_read_or_report_secret_bearing_output(self):
        log, launcher = mock.Mock(), mock.Mock()
        smoke.check_native_start(subprocess.CompletedProcess([], 0), log, launcher, 'startup')
        log.open.assert_not_called()
        launcher.open.assert_not_called()


@unittest.skipUnless(platform.system() == 'Linux' and shutil.which('bash') and shutil.which('systemd-analyze'),
                     'Real unit verification fixtures require Linux systemd tools; no services are started')
class NativeUnitVerificationTests(unittest.TestCase):
    def fixture(self, root, attack=None):
        kit, work = root / 'kit', root / 'work'
        kit.mkdir()
        work.mkdir(mode=0o700)
        native = Path(__file__).resolve().parents[1] / 'deploy/native'
        units = ['vectory-native-' + role for role in ('validator', 'certificates', 'server', 'proxy')]
        originals = {}
        for unit in units:
            content = (native / (unit + '.service')).read_text().replace('@KIT_ROOT@', str(kit))
            for line in content.splitlines():
                if line.startswith('ExecStart='):
                    executable = line.removeprefix('ExecStart=').split()[0]
                    if executable.startswith(str(kit) + '/'):
                        path = Path(executable)
                        path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile('/bin/true', path)
                        path.chmod(0o755)
            path = work / (unit + '.service')
            path.write_text(content)
            originals[unit] = path.read_bytes()
        binary = kit / 'validator-root/usr/local/bin/vector-validator'
        binary.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile('/bin/true', binary)
        binary.chmod(0o755)
        if attack == 'missing':
            binary.unlink()
        elif attack == 'not_executable':
            binary.chmod(0o644)
        elif attack == 'linked':
            binary.unlink()
            binary.symlink_to('/bin/true')
        elif attack in ('duplicate_start', 'different_start'):
            path = work / 'vectory-native-validator.service'
            content = path.read_text()
            if attack == 'duplicate_start':
                content = content.replace('ExecStart=/usr/local/bin/vector-validator',
                                          'ExecStart=/usr/local/bin/vector-validator\nExecStart=/bin/true')
            else:
                content = content.replace('ExecStart=/usr/local/bin/vector-validator', 'ExecStart=/bin/true')
            path.write_text(content)
        source = (native / 'start.sh').read_text()
        self.assertEqual(source.count('regular() {'), 1)
        self.assertEqual(source.count('verify_service_units() {'), 1)
        functions = source[source.index('regular() {'):source.index('load_record() {')]
        script = 'set -euo pipefail\numask 077\nfail() { exit 1; }\n' + functions
        script += '\nkit=' + shlex.quote(str(kit)) + '\nwork=' + shlex.quote(str(work))
        script += '\nunits=(' + ' '.join(shlex.quote(unit) for unit in units) + ')\nverify_service_units\n'
        return script, work, kit, units, originals

    def test_actual_four_unit_verification_preserves_installed_bytes_and_jail_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            script, work, kit, units, originals = self.fixture(Path(directory))
            outcome = subprocess.run(['bash', '-c', script], capture_output=True, timeout=60)
            self.assertEqual(outcome.returncode, 0, 'Private copies of all four native units must pass the real static verifier')
            staging = work / 'verify-units'
            self.assertEqual(stat.S_IMODE(staging.stat().st_mode), 0o700)
            self.assertEqual({path.name for path in staging.iterdir()}, {unit + '.service' for unit in units})
            for unit in units:
                self.assertEqual((work / (unit + '.service')).read_bytes(), originals[unit])
                expected = originals[unit]
                if unit == 'vectory-native-validator':
                    expected = expected.replace(b'ExecStart=/usr/local/bin/vector-validator',
                                                ('ExecStart=' + str(kit / 'validator-root/usr/local/bin/vector-validator')).encode())
                self.assertEqual((staging / (unit + '.service')).read_bytes(), expected)
            self.assertIn(b'RootDirectory=' + str(kit / 'validator-root').encode(),
                          (staging / 'vectory-native-validator.service').read_bytes())

    def test_original_jail_only_path_is_rejected_by_the_host_static_verifier(self):
        self.assertFalse(Path('/usr/local/bin/vector-validator').exists(), 'Fixture requires a clean host executable namespace')
        with tempfile.TemporaryDirectory() as directory:
            _, work, _, units, _ = self.fixture(Path(directory))
            outcome = subprocess.run(['systemd-analyze', 'verify', *[str(work / (unit + '.service')) for unit in units]],
                                     capture_output=True, timeout=60)
            self.assertNotEqual(outcome.returncode, 0, 'Host verification must refuse the jail-only executable path')

    def test_missing_nonexecutable_or_linked_payload_and_changed_commands_fail_closed(self):
        for attack in ('missing', 'not_executable', 'linked', 'duplicate_start', 'different_start'):
            with self.subTest(attack=attack), tempfile.TemporaryDirectory() as directory:
                script, _, _, _, _ = self.fixture(Path(directory), attack)
                outcome = subprocess.run(['bash', '-c', script], capture_output=True, timeout=60)
                self.assertNotEqual(outcome.returncode, 0, 'Unsafe synthetic payload or unit command must be refused')


if __name__ == '__main__':
    unittest.main()
