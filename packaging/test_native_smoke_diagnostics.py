"""Static native failure diagnostics fixtures; no native service execution."""
import importlib.util
from contextlib import contextmanager
import os
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
    return f'VECTORY-NATIVE-FAILURE phase={phase} status={status} line={line}'.encode()


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
                   marker() + b'\n' + marker(), marker() + b'\nVECTORY-NATIVE-FAILURE malformed',
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


@unittest.skipUnless(os.name == 'posix', 'Descriptor permission fixtures require POSIX; no global directory is changed')
class NativeSmokeParentTests(unittest.TestCase):
    @contextmanager
    def owner(self, uid=0):
        original_stat, original_fstat = os.stat, os.fstat

        def changed(record):
            fields = list(record)
            fields[4] = uid
            return os.stat_result(fields)

        with mock.patch.object(smoke.os, 'stat', side_effect=lambda *args, **kwargs: changed(original_stat(*args, **kwargs))), \
                mock.patch.object(smoke.os, 'fstat', side_effect=lambda *args, **kwargs: changed(original_fstat(*args, **kwargs))):
            yield

    def test_descriptor_changes_only_write_bits_on_parent_and_restores_after_stopped(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory) / 'parent'
            parent.mkdir()
            parent.chmod(0o1777)
            child = parent / 'child'
            child.mkdir()
            child.chmod(0o777)
            file = child / 'fixture'
            file.write_text('synthetic permission fixture')
            file.chmod(0o666)
            with self.owner(), mock.patch.object(smoke.os, 'open', wraps=os.open) as opened:
                prepared = smoke.harden_smoke_install_parent(parent)
                try:
                    self.assertEqual(prepared['original_mode'], 0o1777)
                    self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o1755)
                    self.assertEqual(stat.S_IMODE(child.stat().st_mode), 0o777)
                    self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o666)
                    flags = opened.call_args[0][1]
                    self.assertTrue(flags & os.O_NOFOLLOW and flags & os.O_DIRECTORY and flags & os.O_CLOEXEC)
                    smoke.restore_smoke_install_parent(prepared, True)
                    self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o1777)
                    self.assertEqual(stat.S_IMODE(child.stat().st_mode), 0o777)
                    self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o666)
                finally:
                    os.close(prepared['descriptor'])

    def test_link_nondirectory_and_nonroot_ownership_are_refused_without_chmod(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'target'
            target.mkdir()
            target.chmod(0o777)
            link = root / 'link'
            link.symlink_to(target, target_is_directory=True)
            file = root / 'file'
            file.write_text('synthetic file')
            with self.owner(), mock.patch.object(smoke.os, 'fchmod') as chmod:
                for path in (link, file):
                    with self.subTest(path=path.name), self.assertRaises((RuntimeError, OSError)):
                        smoke.harden_smoke_install_parent(path)
                chmod.assert_not_called()
            with self.owner(uid=12345), mock.patch.object(smoke.os, 'fchmod') as chmod, self.assertRaises(RuntimeError):
                smoke.harden_smoke_install_parent(target)
            chmod.assert_not_called()
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o777)

    def test_restore_refuses_unverified_services_changed_identity_or_permissions(self):
        for attack in ('running', 'new_inode', 'changed_mode', 'new_owner'):
            with self.subTest(attack=attack), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'parent'
                path.mkdir()
                path.chmod(0o777)
                with self.owner():
                    prepared = smoke.harden_smoke_install_parent(path)
                try:
                    if attack == 'new_inode':
                        path.rename(Path(directory) / 'retained')
                        path.mkdir()
                        path.chmod(0o777)
                    elif attack == 'changed_mode':
                        path.chmod(0o750)
                    with self.owner(uid=12345 if attack == 'new_owner' else 0), \
                            mock.patch.object(smoke.os, 'fchmod') as chmod, self.assertRaises(RuntimeError):
                        smoke.restore_smoke_install_parent(prepared, attack != 'running')
                    chmod.assert_not_called()
                    if attack == 'running':
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
                finally:
                    os.close(prepared['descriptor'])

    def test_unavailable_service_query_or_active_pid_blocks_restoration(self):
        failures = (subprocess.CompletedProcess([], 1, b''),
                    subprocess.CompletedProcess([], 0, b'LoadState=loaded\nActiveState=inactive\nMainPID=42\n'))
        for failure in failures:
            with self.subTest(status=failure.returncode), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'parent'
                path.mkdir()
                path.chmod(0o777)
                with self.owner():
                    prepared = smoke.harden_smoke_install_parent(path)
                    try:
                        with mock.patch.object(smoke, 'run', return_value=failure):
                            stopped = smoke.native_services_stopped()
                        self.assertFalse(stopped)
                        with mock.patch.object(smoke.os, 'fchmod') as chmod, self.assertRaises(RuntimeError):
                            smoke.restore_smoke_install_parent(prepared, stopped)
                        chmod.assert_not_called()
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
                    finally:
                        os.close(prepared['descriptor'])

    def test_changed_inode_during_protection_refuses_and_closes_owned_descriptor(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'parent'
            path.mkdir()
            path.chmod(0o777)
            fields = list(path.stat())
            fields[4] = 0
            initial = os.stat_result(fields)
            fields[1] += 1
            changed = os.stat_result(fields)
            with self.owner(), mock.patch.object(smoke.os, 'stat', side_effect=[initial, changed]), \
                    mock.patch.object(smoke.os, 'close', wraps=os.close) as close, self.assertRaises(RuntimeError):
                smoke.harden_smoke_install_parent(path)
            close.assert_called_once()
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)

    def test_failed_stop_cannot_restore_even_when_unit_queries_would_report_stopped(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'parent'
            path.mkdir()
            path.chmod(0o777)
            sentinel = Path(directory) / 'sentinel'
            sentinel.write_text('synthetic host sentinel')
            with self.owner():
                prepared = smoke.harden_smoke_install_parent(path)
                inactive = subprocess.CompletedProcess([], 0, b'LoadState=loaded\nActiveState=inactive\nMainPID=0\n')
                with mock.patch.object(smoke, 'run', side_effect=[subprocess.CompletedProcess([], 1)] + [inactive] * 4) as stop, \
                        mock.patch.object(smoke.os, 'fchmod') as chmod, \
                        mock.patch.object(smoke.os, 'close', wraps=os.close) as close, self.assertRaises(RuntimeError):
                    smoke.cleanup_native_smoke(prepared, 'synthetic-launcher', {}, True, sentinel, False)
                stop.assert_called_once_with('synthetic-launcher', 'stop', env={}, check=False)
                chmod.assert_not_called()
                close.assert_called_once_with(prepared['descriptor'])
                self.assertFalse(sentinel.exists())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)

    def test_successful_combined_cleanup_verifies_all_units_then_restores_and_closes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'parent'
            path.mkdir()
            path.chmod(0o777)
            sentinel = Path(directory) / 'sentinel'
            sentinel.write_text('synthetic host sentinel')
            with self.owner():
                prepared = smoke.harden_smoke_install_parent(path)
                inactive = subprocess.CompletedProcess([], 0, b'LoadState=loaded\nActiveState=inactive\nMainPID=0\n')
                with mock.patch.object(smoke, 'run', side_effect=[subprocess.CompletedProcess([], 0)] + [inactive] * 4) as run, \
                        mock.patch.object(smoke.os, 'close', wraps=os.close) as close:
                    self.assertTrue(smoke.cleanup_native_smoke(prepared, 'synthetic-launcher', {}, True, sentinel, False))
                self.assertEqual(run.call_args_list, [mock.call('synthetic-launcher', 'stop', env={}, check=False)] +
                    [mock.call('systemctl', 'show', unit, '--property=LoadState,ActiveState,MainPID', check=False)
                     for unit in smoke.UNITS])
                close.assert_called_once_with(prepared['descriptor'])
                self.assertFalse(sentinel.exists())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o777)


class NativeSmokeStoppedTests(unittest.TestCase):
    def test_all_four_units_must_have_proven_stopped_states(self):
        states = (subprocess.CompletedProcess([], 0, b'LoadState=loaded\nActiveState=inactive\nMainPID=0\n'),
                  subprocess.CompletedProcess([], 0, b'ActiveState=failed\nMainPID=0\nLoadState=loaded\n'))
        for state in states:
            with self.subTest(state=state.stdout), mock.patch.object(smoke, 'run', return_value=state) as run:
                self.assertTrue(smoke.native_services_stopped())
                self.assertEqual(run.call_args_list, [mock.call('systemctl', 'show', unit,
                    '--property=LoadState,ActiveState,MainPID', check=False) for unit in smoke.UNITS])
        for active in (b'active', b'activating', b'deactivating', b'reloading', b'maintenance', b'unknown'):
            result = subprocess.CompletedProcess([], 0, b'LoadState=loaded\nActiveState=' + active + b'\nMainPID=0\n')
            with self.subTest(active=active), mock.patch.object(smoke, 'run', return_value=result):
                self.assertFalse(smoke.native_services_stopped())
        malformed = (subprocess.CompletedProcess([], 1, b'LoadState=loaded\nActiveState=inactive\nMainPID=0\n'),
                     subprocess.CompletedProcess([], 0, b'LoadState=not-found\nActiveState=inactive\nMainPID=0\n'),
                     subprocess.CompletedProcess([], 2, b'LoadState=loaded\nActiveState=inactive\nMainPID=0\n'),
                     subprocess.CompletedProcess([], 0, b'LoadState=loaded\nActiveState=inactive\nMainPID=42\n'),
                     subprocess.CompletedProcess([], 0, b'ActiveState=inactive\nActiveState=inactive\nMainPID=0\n'),
                     subprocess.CompletedProcess([], 0, b'synthetic private log text'),
                     subprocess.CompletedProcess([], 0, b'x' * 257))
        for result in malformed:
            with self.subTest(result=result.stdout[:80]), mock.patch.object(smoke, 'run', return_value=result):
                self.assertFalse(smoke.native_services_stopped())
        with mock.patch.object(smoke, 'run', side_effect=[states[0]] * 3 + [malformed[0]]):
            self.assertFalse(smoke.native_services_stopped())


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
