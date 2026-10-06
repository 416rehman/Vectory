"""Static native failure diagnostics fixtures; no native service execution."""
import importlib.util
from contextlib import contextmanager, nullcontext
import errno
import os
from pathlib import Path
import platform
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import traceback
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


class RetainedWorkerObservationTests(unittest.TestCase):
    def record(self, **changes):
        fields = {'LoadState': 'loaded', 'Result': 'exit-code', 'ExecMainCode': '1',
                  'ExecMainStatus': '1', 'ActiveState': 'failed', 'SubState': 'failed'}
        fields.update(changes)
        return ''.join(key + '=' + value + '\n' for key, value in fields.items()).encode('ascii')

    def query(self, output=None, status=0):
        def invoke(arguments, **options):
            options['stdout'].write(self.record() if output is None else output)
            return subprocess.CompletedProcess(arguments, status)
        return invoke

    def test_only_fixed_enums_and_canonical_numbers_are_returned(self):
        expected = {'LoadState': 'loaded', 'Result': 'exit-code', 'ExecMainCode': 1,
                    'ExecMainStatus': 1, 'ActiveState': 'failed', 'SubState': 'failed'}
        self.assertEqual(smoke.retained_worker_observation(self.record()), expected)
        for key, values in (('Result', smoke.SERVICE_RESULTS),
                            ('ActiveState', smoke.SERVICE_ACTIVE_STATES),
                            ('SubState', smoke.SERVICE_SUB_STATES)):
            for value in values:
                with self.subTest(key=key, value=value):
                    self.assertEqual(smoke.retained_worker_observation(
                        self.record(**{key: value.decode('ascii')}))[key], value.decode('ascii'))
        for code, status in ((0, 0), (6, 255)):
            self.assertEqual(smoke.retained_worker_observation(self.record(
                ExecMainCode=str(code), ExecMainStatus=str(status)))['ExecMainStatus'], status)

    def test_unknown_duplicate_oversized_and_private_fields_are_refused(self):
        valid = self.record()
        attacks = (b'', valid.decode(), valid + b'\n', valid + b'x' * 513,
                   valid.replace(b'LoadState=loaded', b'LoadState=not-found'),
                   valid.replace(b'Result=exit-code', b'Result=outside/path'),
                   valid.replace(b'ActiveState=failed', b'ActiveState=unknown'),
                   valid.replace(b'SubState=failed', b'SubState=unknown'),
                   valid.replace(b'ExecMainCode=1', b'ExecMainCode=7'),
                   valid.replace(b'ExecMainCode=1', b'ExecMainCode=01'),
                   valid.replace(b'ExecMainStatus=1', b'ExecMainStatus=256'),
                   valid.replace(b'ExecMainStatus=1', b'ExecMainStatus=-1'),
                   valid.replace(b'ExecMainStatus=1', b'ExecMainStatus=01'),
                   valid.replace(b'ExecMainStatus=1', b'ExecMainStatus=+1'),
                   valid.replace(b'ExecMainStatus=1', b'ExecMainStatus=\xff'),
                   valid.replace(b'ExecMainStatus=1\n', b''),
                   valid.replace(b'ExecMainStatus=1', b'Result=exit-code'),
                   valid + b'Environment=synthetic-private-secret\n',
                   valid.replace(b'Result=exit-code', b'Result=exit-code\nsynthetic-private-text'))
        for data in attacks:
            with self.subTest(data=repr(data)[:100]):
                self.assertIsNone(smoke.retained_worker_observation(data))

    def test_fixed_query_uses_short_timeout_and_discards_stderr(self):
        with mock.patch.object(smoke.subprocess, 'run', side_effect=self.query()) as query:
            observed = smoke.observe_retained_worker()
        self.assertEqual(observed['Result'], 'exit-code')
        self.assertNotIn('synthetic-private', repr(observed))
        query.assert_called_once_with(('systemctl', 'show', 'vectory-native-validator.service',
            '--property=LoadState,Result,ExecMainCode,ExecMainStatus,ActiveState,SubState'),
            stdout=mock.ANY, stderr=subprocess.DEVNULL, check=False, timeout=5)
        self.assertTrue(query.call_args.kwargs['stdout'].closed)

    def test_failed_malformed_missing_and_timed_out_queries_are_unavailable(self):
        for output, status in ((self.record(), 1), (b'x' * 513, 0),
                               (self.record() + b'Path=synthetic\n', 0)):
            with mock.patch.object(smoke.subprocess, 'run', side_effect=self.query(output, status)):
                self.assertIsNone(smoke.observe_retained_worker())
        for error in (OSError('synthetic-private-path'),
                      subprocess.TimeoutExpired(['synthetic-private-argv'], 5,
                          output=b'synthetic-private-output', stderr=b'synthetic-private-stderr')):
            with mock.patch.object(smoke.subprocess, 'run', side_effect=error):
                self.assertIsNone(smoke.observe_retained_worker())

    def test_query_reads_only_the_size_bound_plus_one_and_closes_private_output(self):
        output = mock.MagicMock()
        output.__enter__.return_value = output
        output.read.return_value = self.record() + b'x' * 513
        with mock.patch.object(smoke.tempfile, 'TemporaryFile', return_value=output), \
                mock.patch.object(smoke.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            self.assertIsNone(smoke.observe_retained_worker())
        output.read.assert_called_once_with(513)
        output.__exit__.assert_called_once()

    def test_worker_failure_still_raises_with_labeled_safe_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log, launcher = root / 'private.log', root / 'launcher.sh'
            launcher.write_bytes(b'fixed launcher source line\n' * 80)
            log.write_bytes(b'synthetic-private-secret\n' + marker(phase='validator_readiness') + b'\n')
            with mock.patch.object(smoke.subprocess, 'run', side_effect=self.query()) as query, self.assertRaises(RuntimeError) as failure:
                smoke.check_native_start(subprocess.CompletedProcess([], 1), log, launcher, 'startup')
            self.assertEqual(str(failure.exception), 'Native startup failed at phase=validator_readiness line=40 status=1; retained worker observation after launcher cleanup=LoadState=loaded,Result=exit-code,ExecMainCode=1,ExecMainStatus=1,ActiveState=failed,SubState=failed; retained observed worker error=unavailable; private output was not published')
            self.assertNotIn('synthetic-private', str(failure.exception))
            self.assertNotIn(str(root), str(failure.exception))
            self.assertEqual(query.call_count, 2)
            with mock.patch.object(smoke.subprocess, 'run', side_effect=OSError('synthetic-private-path')), self.assertRaises(RuntimeError) as failure:
                smoke.check_native_start(subprocess.CompletedProcess([], 1), log, launcher, 'restart')
            self.assertEqual(str(failure.exception), 'Native restart failed at phase=validator_readiness line=40 status=1; retained worker observation after launcher cleanup=unavailable; retained observed worker error=unavailable; private output was not published')

    def test_success_nonworker_and_invalid_markers_never_query_service_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log, launcher = root / 'private.log', root / 'launcher.sh'
            launcher.write_bytes(b'fixed launcher source line\n' * 80)
            with mock.patch.object(smoke.subprocess, 'run') as query:
                smoke.check_native_start(subprocess.CompletedProcess([], 0), log, launcher, 'startup')
                for data in (marker(), marker(phase='validator_readiness') + b'\n' + marker()):
                    log.write_bytes(data)
                    with self.assertRaises(RuntimeError):
                        smoke.check_native_start(subprocess.CompletedProcess([], 1), log, launcher, 'startup')
                query.assert_not_called()


class RetainedWorkerErrorTests(unittest.TestCase):
    def test_exact_public_worker_sentences_and_fixed_signal_lines_return_only_ids(self):
        root = Path(__file__).resolve().parents[1]
        public_source = (root / 'server/src/bin/vector-validator.rs').read_bytes()
        public_source += (root / 'server/src/validation_socket.rs').read_bytes()
        for sentence, identifier in smoke.WORKER_ERROR_SENTENCES.items():
            with self.subTest(identifier=identifier):
                # This single generic sentence was public in the 5c source;
                # it stays compatible with older records after the refinement.
                if identifier != 'socket_ancestors':
                    self.assertIn(sentence.removeprefix(b'Error: '), public_source)
                self.assertEqual(smoke.retained_worker_error(sentence + b'\n'), identifier)
                self.assertEqual(smoke.retained_worker_error(
                    b'synthetic-private-message\n' + sentence + b'\n' + sentence + b'\n'), identifier)
        for sentence in smoke.SYSTEMD_WORKER_ERROR_LINES:
            self.assertEqual(smoke.retained_worker_error(sentence), 'syscall_signal')

    def test_all_twelve_fixed_ancestor_reasons_keep_companion_and_ambiguity_rules(self):
        for category in ('leaf', 'parent', 'root', 'other'):
            for reason in ('directory', 'write', 'owner'):
                identifier = 'socket_ancestor_' + category + '_' + reason
                sentence = ('Error: Validator socket ancestor ' + category + ' failed ' + reason + ' safety check').encode('ascii')
                with self.subTest(identifier=identifier):
                    self.assertEqual(smoke.WORKER_ERROR_SENTENCES[sentence], identifier)
                    self.assertEqual(smoke.retained_worker_error(sentence + b'\n' + sentence + b'\n' + smoke.WORKER_EXIT_COMPANION), identifier)
                    self.assertIsNone(smoke.retained_worker_error(sentence + b' extra-private-text'))
                    different = ('Error: Validator socket ancestor ' + category + ' failed ' +
                        ('owner' if reason != 'owner' else 'write') + ' safety check').encode('ascii')
                    self.assertIsNone(smoke.retained_worker_error(sentence + b'\n' + different))
        for category, reason in (('unknown', 'write'), ('root', 'unknown'), ('ROOT', 'owner'), ('parent/private', 'write')):
            sentence = ('Error: Validator socket ancestor ' + category + ' failed ' + reason + ' safety check').encode('ascii')
            self.assertIsNone(smoke.retained_worker_error(sentence))

    def test_unknown_ambiguous_malformed_and_private_injections_are_unavailable(self):
        known = next(iter(smoke.WORKER_ERROR_SENTENCES))
        different = list(smoke.WORKER_ERROR_SENTENCES)[1]
        signal = next(iter(smoke.SYSTEMD_WORKER_ERROR_LINES))
        attacks = (b'', known.decode(), b'synthetic-private-message', b'Error: synthetic-private-error',
                   known + b' synthetic-private-path', b'prefix ' + known, b'\x00' + known,
                   b'\xff' + known, known + b'\n' + different, known + b'\n' + signal,
                   known + b'\nError: synthetic-private-error', known + b'\n' + b'x' * 8193,
                   signal.replace(b'vectory-native-validator.service', b'other.service'),
                   signal.replace(b'status=31/SYS', b'status=15/TERM'),
                   signal + b'\n' + smoke.WORKER_EXIT_COMPANION)
        for data in attacks:
            with self.subTest(data=repr(data)[:100]):
                self.assertIsNone(smoke.retained_worker_error(data))

    def test_exit_companion_is_ignored_only_with_one_exact_worker_error(self):
        companion = smoke.WORKER_EXIT_COMPANION
        known, identifier = next(iter(smoke.WORKER_ERROR_SENTENCES.items()))
        self.assertIsNone(smoke.retained_worker_error(companion))
        self.assertEqual(smoke.retained_worker_error(known + b'\n' + companion), identifier)
        self.assertIsNone(smoke.retained_worker_error(b'Error: synthetic-private-error\n' + companion))
        signal = next(iter(smoke.SYSTEMD_WORKER_ERROR_LINES))
        self.assertIsNone(smoke.retained_worker_error(known + b'\n' + signal + b'\n' + companion))

    def test_private_fixed_query_has_bounded_read_permissions_timeout_and_cleanup(self):
        known, identifier = next(iter(smoke.WORKER_ERROR_SENTENCES.items()))
        paths = []

        def invoke(arguments, **options):
            path = Path(options['stdout'].name)
            paths.append(path)
            if os.name == 'posix':
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            options['stdout'].write(b'synthetic-private-message\n' + known + b'\n')
            return subprocess.CompletedProcess(arguments, 0)

        with mock.patch.object(smoke.subprocess, 'run', side_effect=invoke) as query, \
                mock.patch.object(smoke, 'retained_worker_error', wraps=smoke.retained_worker_error) as classify:
            self.assertEqual(smoke.observe_retained_worker_error(), identifier)
        query.assert_called_once_with(('journalctl', '--boot=0',
            '--unit=vectory-native-validator.service', '--output=cat', '--no-pager', '--lines=40'),
            stdout=mock.ANY, stderr=subprocess.DEVNULL, check=False, timeout=5)
        self.assertTrue(query.call_args.kwargs['stdout'].closed)
        self.assertEqual(classify.call_count, 1)
        self.assertTrue(all(not path.exists() and not path.parent.exists() for path in paths))

    def test_overbound_failed_and_timed_out_queries_never_return_private_content(self):
        known = next(iter(smoke.WORKER_ERROR_SENTENCES))
        for content, status in ((known + b'\n' + b'x' * 16384, 0), (known, 1),
                                (b'Error: synthetic-private-error', 0)):
            paths = []

            def invoke(arguments, **options):
                paths.append(Path(options['stdout'].name))
                options['stdout'].write(content)
                return subprocess.CompletedProcess(arguments, status)

            with mock.patch.object(smoke.subprocess, 'run', side_effect=invoke), \
                    mock.patch.object(smoke, 'retained_worker_error', wraps=smoke.retained_worker_error) as classify:
                self.assertIsNone(smoke.observe_retained_worker_error())
            if status == 0:
                self.assertLessEqual(len(classify.call_args.args[0]), 8193)
            self.assertTrue(all(not path.exists() and not path.parent.exists() for path in paths))
        for error in (OSError('synthetic-private-path'),
                      subprocess.TimeoutExpired(['synthetic-private-argv'], 5,
                          output=b'synthetic-private-output', stderr=b'synthetic-private-stderr')):
            with mock.patch.object(smoke.subprocess, 'run', side_effect=error):
                self.assertIsNone(smoke.observe_retained_worker_error())

    def test_combined_failure_discloses_only_an_observed_identifier(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log, launcher = root / 'private.log', root / 'launcher.sh'
            launcher.write_bytes(b'fixed launcher source line\n' * 80)
            log.write_bytes(b'synthetic-private-secret\n' + marker(phase='validator_readiness') + b'\n')
            sentence = next(line for line, identifier in smoke.WORKER_ERROR_SENTENCES.items()
                if identifier == 'socket_parent_mode')

            def invoke(arguments, **options):
                options['stdout'].write(sentence if arguments[0] == 'journalctl' else b'unknown-private-state')
                return subprocess.CompletedProcess(arguments, 0)

            with mock.patch.object(smoke.subprocess, 'run', side_effect=invoke), self.assertRaises(RuntimeError) as failure:
                smoke.check_native_start(subprocess.CompletedProcess([], 1), log, launcher, 'startup')
            self.assertEqual(str(failure.exception), 'Native startup failed at phase=validator_readiness line=40 status=1; retained worker observation after launcher cleanup=unavailable; retained observed worker error=socket_parent_mode; private output was not published')
            self.assertNotIn(sentence.decode(), str(failure.exception))
            self.assertNotIn('synthetic-private', str(failure.exception))
            self.assertNotIn(str(root), str(failure.exception))


@unittest.skipUnless(platform.system() == 'Linux' and shutil.which('bash') and shutil.which('stat'),
    'Launcher identity fixtures require Linux GNU stat; no services execute')
class NativeLauncherRootIdentityTests(unittest.TestCase):
    def invoke(self, root, observed, expected, attack='none'):
        launcher = Path(__file__).resolve().parents[1] / 'deploy/native/start.sh'
        source = launcher.read_text()
        import re
        functions = []
        for name in ('root_directory', 'worker_root_identity'):
            found = re.search(r'^' + name + r'\(\) \{\n.*?^\}', source, re.M | re.S)
            self.assertIsNotNone(found)
            functions.append(found.group())
        fail = re.search(r'^fail\(\) \{.*\}$', source, re.M)
        self.assertIsNotNone(fail)
        program = root / 'probe.sh'
        program.write_text('set -euo pipefail\nnative_failure_line=0\n' + fail.group() + '\n' +
            '\n'.join(functions) + '\nworker_root_identity "$1" "$2"\n')
        shim = root / 'tools'
        shim.mkdir(exist_ok=True)
        original = shutil.which('stat')
        script = shim / 'stat'
        script.write_text('''#!/usr/bin/env bash
set -euo pipefail
path="${@: -1}"
if [[ "$1" == -c && "$2" == %u ]]; then
  if [[ "$path" == "$ROOT_IDENTITY_EXPECTED" && "$ROOT_IDENTITY_ATTACK" == owner ]]; then printf '12345\\n'; else printf '0\\n'; fi
elif [[ "$1" == -c && "$2" == %a ]]; then
  if [[ "$path" == "$ROOT_IDENTITY_EXPECTED" && "$ROOT_IDENTITY_ATTACK" == mode ]]; then printf '777\\n'; else printf '755\\n'; fi
elif [[ "$1" == -Lc && "$2" == %d:%i ]]; then
  if [[ "$path" == "$ROOT_IDENTITY_OBSERVED" ]]; then
    case "$ROOT_IDENTITY_ATTACK" in
      error) printf 'synthetic-private-stat-error:%s\\n' "$path" >&2; exit 1 ;;
      malformed) printf 'synthetic-private-metadata\\n'; exit 0 ;;
      device|inode)
        value="$("$ROOT_IDENTITY_REAL_STAT" "$@")"
        device="${value%%:*}"; inode="${value#*:}"
        if [[ "$ROOT_IDENTITY_ATTACK" == device ]]; then device=$((device + 1)); else inode=$((inode + 1)); fi
        printf '%s:%s\\n' "$device" "$inode"; exit 0 ;;
    esac
  fi
  exec "$ROOT_IDENTITY_REAL_STAT" "$@"
else exit 90
fi
''')
        script.chmod(0o755)
        readlink = shim / 'readlink'
        readlink.write_text('#!/usr/bin/env bash\nprintf "unexpected namespace label read\\n" >&2\nexit 91\n')
        readlink.chmod(0o755)
        environment = os.environ.copy()
        environment.update(PATH=str(shim) + os.pathsep + environment['PATH'],
            ROOT_IDENTITY_EXPECTED=str(expected), ROOT_IDENTITY_OBSERVED=str(observed),
            ROOT_IDENTITY_ATTACK=attack, ROOT_IDENTITY_REAL_STAT=original)
        return subprocess.run(['bash', str(program), str(observed), str(expected)], env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)

    def test_exact_launcher_helper_accepts_real_same_inode_alias_without_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            expected = root / 'authenticated-root'
            expected.mkdir()
            observed = root / 'namespace-root-label'
            observed.symlink_to(expected, target_is_directory=True)
            result = self.invoke(root, observed, expected)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b'')
            self.assertEqual(result.stderr, b'')

    def test_exact_launcher_helper_refuses_wrong_objects_and_metadata_errors_privately(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            expected, other = root / 'authenticated-root', root / 'different-root'
            expected.mkdir(); other.mkdir()
            observed = root / 'namespace-root-label'
            observed.symlink_to(expected, target_is_directory=True)
            for candidate, attack in ((other, 'none'), (Path('/proc/self/root'), 'none'),
                    (observed, 'device'), (observed, 'inode'), (observed, 'error'), (observed, 'malformed')):
                with self.subTest(attack=attack, candidate=candidate.name):
                    result = self.invoke(root, candidate, expected, attack)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, b'')
                    self.assertNotIn(str(root).encode(), result.stderr)
                    self.assertNotIn(str(candidate).encode(), result.stderr)
                    self.assertNotIn(b'synthetic-private', result.stderr)

    def test_exact_launcher_helper_keeps_canonical_directory_ownership_and_mode_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            expected = root / 'authenticated-root'
            expected.mkdir()
            observed = root / 'namespace-root-label'
            observed.symlink_to(expected, target_is_directory=True)
            linked = root / 'linked-expected'
            linked.symlink_to(expected, target_is_directory=True)
            missing = root / 'missing-expected'
            file = root / 'file-expected'
            file.write_bytes(b'synthetic protected root fixture')
            for candidate, attack in ((expected, 'owner'), (expected, 'mode'), (linked, 'none'),
                                      (missing, 'none'), (file, 'none')):
                with self.subTest(attack=attack, candidate=candidate.name):
                    result = self.invoke(root, observed, candidate, attack)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, b'')
                    self.assertNotIn(str(root).encode(), result.stderr)


@unittest.skipUnless(os.name == 'posix', 'Payload mount fixtures use only private POSIX directories and descriptors')
class NativeWorkerPayloadMountTests(unittest.TestCase):
    @contextmanager
    def directories(self, attack=None, relative='usr/local/bin'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = root / 'usr/local/bin'
            parent.mkdir(parents=True, mode=0o755)
            existing = parent / 'vector-validator'
            existing.write_bytes(b'unchanged synthetic executable fixture')
            target = root / relative
            if attack == 'mode':
                target.chmod(0o777)
            elif attack in ('link', 'file'):
                target.rename(root / 'original-parent')
                if attack == 'link':
                    target.symlink_to(root / 'original-parent', target_is_directory=True)
                else:
                    target.write_bytes(b'synthetic non-directory fixture')
            original_lstat, original_fstat = Path.lstat, os.fstat

            def metadata(path):
                fields = list(original_lstat(path))
                if path in (root / 'usr', root / 'usr/local', parent):
                    fields[4] = 12345 if attack == 'owner' and path == target else 0
                return os.stat_result(fields)

            def bound(descriptor):
                fields = list(original_fstat(descriptor))
                if stat.S_ISDIR(fields[0]):
                    fields[4] = 0
                return os.stat_result(fields)

            with mock.patch.object(Path, 'lstat', metadata), mock.patch.object(smoke.os, 'fstat', bound):
                yield root, parent, existing

    @contextmanager
    def readonly(self, refusal=errno.EROFS):
        original = os.open

        def open_file(path, flags, mode=0o777, **options):
            if options.get('dir_fd') is not None and str(path).startswith('.vectory-native-ci-payload-ro-'):
                raise OSError(refusal, 'synthetic private mount refusal', 'synthetic-private-probe-file')
            return original(path, flags, mode, **options)

        with mock.patch.object(smoke.os, 'open', side_effect=open_file) as opened:
            yield opened

    def assert_private(self, failure, root):
        rendered = ''.join(traceback.format_exception(failure))
        self.assertNotIn(str(root), rendered)
        self.assertNotIn('synthetic private', rendered)
        self.assertNotIn('synthetic-private', rendered)

    def test_only_fresh_exclusive_probe_accepts_ero_fs_and_closes_the_parent_descriptor(self):
        with self.directories() as (root, parent, existing), self.readonly() as opened, \
                mock.patch.object(smoke.os, 'close', wraps=os.close) as closed:
            smoke.check_worker_payload_mount(root)
            calls = opened.call_args_list
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0].args[0], parent)
            self.assertTrue(calls[0].args[1] & os.O_DIRECTORY and calls[0].args[1] & os.O_NOFOLLOW
                            and calls[0].args[1] & os.O_CLOEXEC)
            name, flags, mode = calls[1].args
            self.assertRegex(name, r'^\.vectory-native-ci-payload-ro-[a-f0-9]{24}$')
            self.assertTrue(flags & os.O_WRONLY and flags & os.O_CREAT and flags & os.O_EXCL
                            and flags & os.O_NOFOLLOW and flags & os.O_CLOEXEC)
            self.assertEqual(mode, 0o600)
            closed.assert_called_once_with(calls[1].kwargs['dir_fd'])
            with self.assertRaises(OSError):
                os.fstat(calls[1].kwargs['dir_fd'])
            self.assertEqual(existing.read_bytes(), b'unchanged synthetic executable fixture')
            self.assertEqual(list(parent.iterdir()), [existing])

    def test_writable_mount_is_refused_after_removing_only_the_owned_probe(self):
        with self.directories() as (root, parent, existing), \
                mock.patch.object(smoke.os, 'close', wraps=os.close) as closed, \
                mock.patch.object(smoke.os, 'unlink', wraps=os.unlink) as removed:
            with self.assertRaises(RuntimeError) as failure:
                smoke.check_worker_payload_mount(root)
            self.assertEqual(str(failure.exception), 'Private worker payload permits writes')
            self.assertEqual(closed.call_count, 2)
            self.assertEqual(removed.call_count, 1)
            self.assertTrue(removed.call_args.kwargs['dir_fd'] >= 0)
            self.assertRegex(removed.call_args.args[0], r'^\.vectory-native-ci-payload-ro-[a-f0-9]{24}$')
            self.assertEqual(list(parent.iterdir()), [existing])
            self.assertEqual(existing.read_bytes(), b'unchanged synthetic executable fixture')
            self.assert_private(failure.exception, root)

    def test_other_errors_including_text_file_busy_never_count_as_readonly(self):
        for refusal in (errno.ETXTBSY, errno.EACCES, errno.EPERM, errno.EEXIST, errno.ENOENT):
            with self.subTest(refusal=refusal), self.directories() as (root, parent, existing), \
                    self.readonly(refusal), self.assertRaises(RuntimeError) as failure:
                smoke.check_worker_payload_mount(root)
            self.assertEqual(str(failure.exception), 'Private worker payload is not protected by a read-only mount')
            self.assert_private(failure.exception, root)

    def test_unsafe_or_linked_ancestry_is_refused_before_any_open(self):
        for relative in ('usr', 'usr/local', 'usr/local/bin'):
            for attack in ('owner', 'mode', 'link', 'file'):
                with self.subTest(relative=relative, attack=attack), self.directories(attack, relative) as (root, parent, existing), \
                        mock.patch.object(smoke.os, 'open') as opened, self.assertRaises(RuntimeError) as failure:
                    smoke.check_worker_payload_mount(root)
                opened.assert_not_called()
                self.assertEqual(str(failure.exception), 'Private worker payload ancestry is not protected')
                self.assert_private(failure.exception, root)

    def test_directory_descriptor_identity_and_permissions_must_match(self):
        for index, replacement in ((1, lambda value: value + 1), (2, lambda value: value + 1),
                                   (4, lambda _: 12345), (0, lambda _: stat.S_IFDIR | 0o777),
                                   (0, lambda _: stat.S_IFREG | 0o755)):
            with self.subTest(index=index), self.directories() as (root, parent, existing):
                original = smoke.os.fstat

                def changed(descriptor):
                    fields = list(original(descriptor))
                    fields[index] = replacement(fields[index])
                    return os.stat_result(fields)

                with mock.patch.object(smoke.os, 'fstat', changed), \
                        mock.patch.object(smoke.os, 'open', wraps=os.open) as opened, \
                        mock.patch.object(smoke.os, 'close', wraps=os.close) as closed, self.assertRaises(RuntimeError) as failure:
                    smoke.check_worker_payload_mount(root)
                self.assertEqual(len(opened.call_args_list), 1)
                closed.assert_called_once()
                self.assertEqual(str(failure.exception), 'Private worker payload directory identity changed')
                self.assert_private(failure.exception, root)

    def test_changed_probe_inode_refuses_unrelated_cleanup_and_closes_both_descriptors(self):
        with self.directories() as (root, parent, existing):
            original = os.stat

            def changed(path, **options):
                record = original(path, **options)
                if options.get('dir_fd') is not None:
                    fields = list(record)
                    fields[1] += 1
                    return os.stat_result(fields)
                return record

            with mock.patch.object(smoke.os, 'stat', changed), mock.patch.object(smoke.os, 'unlink') as removed, \
                    mock.patch.object(smoke.os, 'close', wraps=os.close) as closed, self.assertRaises(RuntimeError) as failure:
                smoke.check_worker_payload_mount(root)
            removed.assert_not_called()
            self.assertEqual(closed.call_count, 2)
            self.assertEqual(str(failure.exception), 'Private worker payload probe identity changed; cleanup was refused')
            self.assertEqual(len(list(parent.iterdir())), 2)
            self.assertEqual(existing.read_bytes(), b'unchanged synthetic executable fixture')
            self.assert_private(failure.exception, root)

    def test_filename_bearing_metadata_open_and_cleanup_errors_are_suppressed(self):
        for operation in ('lstat', 'open', 'fstat', 'stat', 'unlink', 'file_close', 'directory_close'):
            with self.subTest(operation=operation), self.directories() as (root, parent, existing):
                private = OSError(errno.EIO, 'synthetic private payload refusal', str(root / 'private-file'))
                original_fstat, original_close = smoke.os.fstat, os.close

                def fstat(descriptor):
                    record = original_fstat(descriptor)
                    if stat.S_ISREG(record.st_mode):
                        raise private
                    return record

                def close(descriptor):
                    regular = stat.S_ISREG(original_fstat(descriptor).st_mode)
                    original_close(descriptor)
                    if regular == (operation == 'file_close'):
                        raise private

                target, name, replacement = {
                    'lstat': (Path, 'lstat', mock.Mock(side_effect=private)),
                    'open': (smoke.os, 'open', mock.Mock(side_effect=private)),
                    'fstat': (smoke.os, 'fstat', fstat),
                    'stat': (smoke.os, 'stat', mock.Mock(side_effect=private)),
                    'unlink': (smoke.os, 'unlink', mock.Mock(side_effect=private)),
                    'file_close': (smoke.os, 'close', close),
                    'directory_close': (smoke.os, 'close', close),
                }[operation]
                with mock.patch.object(target, name, replacement), self.assertRaises(RuntimeError) as failure:
                    smoke.check_worker_payload_mount(root)
                self.assertEqual(str(failure.exception), 'Private worker payload mount could not be safely checked')
                self.assert_private(failure.exception, root)

    def test_active_caller_private_context_is_suppressed_on_writable_refusal(self):
        with self.directories() as (root, parent, existing):
            try:
                raise OSError(errno.EIO, 'synthetic private caller refusal', str(root / 'private-caller-file'))
            except OSError:
                with self.assertRaises(RuntimeError) as failure:
                    smoke.check_worker_payload_mount(root)
            self.assertEqual(list(parent.iterdir()), [existing])
            self.assert_private(failure.exception, root)


@unittest.skipUnless(os.name == 'posix', 'Root identity fixtures use only private POSIX temporary directories')
class NativeWorkerRootIdentityTests(unittest.TestCase):
    @contextmanager
    def directories(self, expected_changes=None, actual_changes=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            expected = root / 'authenticated-root'
            expected.mkdir(mode=0o755)
            observed = root / 'observed-root'
            observed.symlink_to(expected, target_is_directory=True)
            original_lstat, original_stat = Path.lstat, Path.stat

            def changed(record, changes):
                fields = list(record)
                fields[4] = 0
                for index, value in (changes or {}).items():
                    fields[index] = value(fields[index]) if callable(value) else value
                return os.stat_result(fields)

            def lstat(path):
                record = original_lstat(path)
                return changed(record, expected_changes) if path.name == expected.name else record

            def stat_path(path, *args, **options):
                record = original_stat(path, *args, **options)
                return changed(record, actual_changes) if path == observed else record

            with mock.patch.object(Path, 'lstat', lstat), mock.patch.object(Path, 'stat', stat_path):
                yield root, expected, observed

    def test_same_actual_object_is_accepted_without_reading_namespace_path_labels(self):
        with self.directories() as (root, expected, observed):
            original = os.readlink

            def label(path, *args, **options):
                return '/' if Path(path) == observed else original(path, *args, **options)

            with mock.patch.object(smoke.os, 'readlink', side_effect=label) as labels:
                smoke.check_worker_root_identity(observed, expected)
                self.assertFalse(any(Path(call.args[0]) == observed for call in labels.call_args_list))

    def test_wrong_root_device_inode_type_owner_and_permissions_are_refused(self):
        changes = ({2: lambda value: value + 1}, {1: lambda value: value + 1},
                   {0: stat.S_IFREG | 0o755}, {4: 12345}, {0: stat.S_IFDIR | 0o777})
        for change in changes:
            with self.subTest(change=change), self.directories(actual_changes=change) as (root, expected, observed), \
                    self.assertRaises(RuntimeError) as failure:
                smoke.check_worker_root_identity(observed, expected)
            self.assertEqual(str(failure.exception), 'Actual worker root object differs from the authenticated private payload')
        with self.directories() as (root, expected, observed), self.assertRaises(RuntimeError):
            smoke.check_worker_root_identity(Path('/'), expected)

    def test_expected_root_must_be_protected_root_owned_and_a_directory(self):
        for change in ({4: 12345}, {0: stat.S_IFDIR | 0o777}, {0: stat.S_IFREG | 0o755}):
            with self.subTest(change=change), self.directories(expected_changes=change) as (root, expected, observed):
                original = Path.stat
                with mock.patch.object(Path, 'stat', autospec=True, side_effect=original) as actual, \
                        self.assertRaises(RuntimeError) as failure:
                    smoke.check_worker_root_identity(observed, expected)
                self.assertFalse(any(call.args[0] == observed for call in actual.call_args_list))
            self.assertEqual(str(failure.exception), 'Authenticated worker root is not a canonical protected directory')

    def test_broken_linked_and_noncanonical_expected_roots_are_refused(self):
        with self.directories() as (root, expected, observed):
            linked = root / 'linked-expected'
            linked.symlink_to(expected, target_is_directory=True)
            broken = root / 'broken-expected'
            broken.symlink_to(root / 'missing-expected', target_is_directory=True)
            parent = root / 'linked-parent'
            parent.symlink_to(root, target_is_directory=True)
            for candidate in (linked, broken, parent / expected.name, Path('.')):
                with self.subTest(candidate=candidate.name), self.assertRaises(RuntimeError):
                    smoke.check_worker_root_identity(observed, candidate)
            protected = expected.lstat()
            with mock.patch.object(Path, 'lstat', return_value=protected), \
                    mock.patch.object(Path, 'resolve') as resolve, self.assertRaises(RuntimeError):
                smoke.check_worker_root_identity(observed, Path('.'))
            resolve.assert_not_called()

    def test_missing_and_inaccessible_metadata_never_render_private_paths(self):
        with self.directories() as (root, expected, observed):
            with self.assertRaises(RuntimeError) as missing:
                smoke.check_worker_root_identity(observed, root / 'missing-expected')
            self.assertEqual(str(missing.exception), 'Actual worker root metadata could not be safely checked')
            self.assertNotIn(str(root), ''.join(traceback.format_exception(missing.exception)))
            original = Path.stat

            def refuse(path, *args, **options):
                if path == observed:
                    raise OSError(errno.EACCES, 'synthetic private root refusal', str(path))
                return original(path, *args, **options)

            with mock.patch.object(Path, 'stat', refuse), self.assertRaises(RuntimeError) as failure:
                smoke.check_worker_root_identity(observed, expected)
            self.assertEqual(str(failure.exception), 'Actual worker root metadata could not be safely checked')
            rendered = ''.join(traceback.format_exception(failure.exception))
            self.assertNotIn(str(root), rendered)
            self.assertNotIn('synthetic private root refusal', rendered)
            with mock.patch.object(Path, 'resolve', side_effect=RuntimeError('synthetic private resolution ' + str(expected))), \
                    self.assertRaises(RuntimeError) as resolution:
                smoke.check_worker_root_identity(observed, expected)
            self.assertEqual(str(resolution.exception), 'Actual worker root metadata could not be safely checked')
            rendered = ''.join(traceback.format_exception(resolution.exception))
            self.assertNotIn(str(root), rendered)
            self.assertNotIn('synthetic private resolution', rendered)

    def test_refusal_suppresses_active_caller_filename_context(self):
        with self.directories(actual_changes={1: lambda value: value + 1}) as (root, expected, observed):
            try:
                raise OSError(errno.EIO, 'synthetic private caller refusal', str(root / 'private-caller-file'))
            except OSError:
                with self.assertRaises(RuntimeError) as failure:
                    smoke.check_worker_root_identity(observed, expected)
            rendered = ''.join(traceback.format_exception(failure.exception))
            self.assertNotIn(str(root), rendered)
            self.assertNotIn('synthetic private caller refusal', rendered)


@unittest.skipUnless(os.name == 'posix', 'Runtime mount fixtures use only private POSIX temporary directories')
class NativeWorkerRuntimeMountTests(unittest.TestCase):
    @contextmanager
    def directories(self, attack=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run, leaf = root / 'run', root / 'run/vectory-validator'
            leaf.mkdir(parents=True)
            run.chmod(0o777 if attack == 'run_mode' else 0o755)
            leaf.chmod(0o770 if attack == 'leaf_mode' else 0o750)
            if attack == 'run_link':
                target = root / 'run-original'
                run.rename(target)
                run.symlink_to(target, target_is_directory=True)
            elif attack == 'leaf_link':
                target = run / 'leaf-original'
                leaf.rename(target)
                leaf.symlink_to(target, target_is_directory=True)
            original = Path.lstat

            def metadata(path):
                record = original(path)
                fields = list(record)
                if path == run:
                    fields[4] = 12345 if attack == 'run_owner' else 0
                elif path == leaf:
                    fields[4] = 12345 if attack == 'leaf_owner' else 10001
                    fields[5] = 12345 if attack == 'leaf_group' else 10001
                return os.stat_result(fields)

            with mock.patch.object(Path, 'lstat', metadata):
                yield root, run, leaf

    @contextmanager
    def readonly(self, run, refusal=errno.EROFS, leaf_refusal=None):
        original = os.open

        def open_file(path, flags, mode=0o777, **options):
            candidate = Path(path)
            if candidate.parent == run and candidate.name.startswith('.vectory-native-ci-readonly-') and refusal is not None:
                raise OSError(refusal, 'synthetic private refusal', str(candidate))
            if candidate.parent == run / 'vectory-validator' and leaf_refusal is not None:
                raise OSError(leaf_refusal, 'synthetic private leaf refusal', str(candidate))
            return original(path, flags, mode, **options)

        with mock.patch.object(smoke.os, 'open', side_effect=open_file) as opened:
            yield opened

    def test_readonly_parent_and_private_writable_leaf_keep_existing_files(self):
        with self.directories() as (root, run, leaf):
            kept = leaf / 'existing-synthetic-fixture'
            kept.write_bytes(b'keep this fixture')
            with self.readonly(run) as opened:
                smoke.check_worker_runtime_mount(root, 10001, 10001)
            calls = opened.call_args_list
            self.assertEqual(len(calls), 2)
            for call in calls:
                path, flags, mode = call.args
                self.assertRegex(Path(path).name, r'^\.vectory-native-ci-(readonly|leaf)-[a-f0-9]{24}$')
                self.assertTrue(flags & os.O_EXCL and flags & os.O_NOFOLLOW)
                self.assertEqual(mode, 0o600)
            self.assertTrue(calls[1].args[1] & os.O_RDWR)
            self.assertEqual(kept.read_bytes(), b'keep this fixture')
            self.assertEqual(list(leaf.iterdir()), [kept])
            self.assertEqual(list(run.iterdir()), [leaf])

    def test_unsafe_directories_are_refused_before_any_write(self):
        for attack in ('run_owner', 'run_mode', 'run_link', 'leaf_owner', 'leaf_group', 'leaf_mode', 'leaf_link'):
            with self.subTest(attack=attack), self.directories(attack) as (root, run, leaf), \
                    mock.patch.object(smoke.os, 'open') as opened, self.assertRaises(RuntimeError):
                smoke.check_worker_runtime_mount(root, 10001, 10001)
            opened.assert_not_called()

    def test_other_refusals_writable_parent_and_readonly_leaf_fail_safely(self):
        for refusal in (errno.EACCES, errno.EPERM, errno.EEXIST, None):
            with self.subTest(refusal=refusal), self.directories() as (root, run, leaf), \
                    self.readonly(run, refusal=refusal), self.assertRaises(RuntimeError) as failure:
                smoke.check_worker_runtime_mount(root, 10001, 10001)
            self.assertNotIn(str(root), str(failure.exception))
            self.assertNotIn('synthetic private', str(failure.exception))
            rendered = ''.join(traceback.format_exception(failure.exception))
            self.assertNotIn(str(root), rendered)
            self.assertNotIn('synthetic private refusal', rendered)
        with self.directories() as (root, run, leaf), self.readonly(run, leaf_refusal=errno.EROFS), \
                self.assertRaises(RuntimeError) as failure:
            smoke.check_worker_runtime_mount(root, 10001, 10001)
        self.assertEqual(str(failure.exception), 'Private worker runtime mount could not be safely checked')
        rendered = ''.join(traceback.format_exception(failure.exception))
        self.assertNotIn(str(root), rendered)
        self.assertNotIn('synthetic private leaf refusal', rendered)

    def test_short_write_and_wrong_read_close_and_remove_the_owned_fixture(self):
        for operation, result in (('write', 0), ('read', b'wrong synthetic fixture')):
            with self.subTest(operation=operation), self.directories() as (root, run, leaf), \
                    self.readonly(run), mock.patch.object(smoke.os, operation, return_value=result), \
                    mock.patch.object(smoke.os, 'close', wraps=os.close) as closed:
                with self.assertRaises(RuntimeError):
                    smoke.check_worker_runtime_mount(root, 10001, 10001)
                closed.assert_called_once()
                self.assertEqual(list(leaf.iterdir()), [])

    def test_changed_fixture_identity_refuses_unrelated_cleanup(self):
        for operation in (None, 'write', 'read'):
            with self.subTest(operation=operation), self.directories() as (root, run, leaf), self.readonly(run):
                original = Path.lstat

                def changed(path):
                    record = original(path)
                    if path.parent == leaf and path.name.startswith('.vectory-native-ci-leaf-'):
                        fields = list(record)
                        fields[1] += 1
                        return os.stat_result(fields)
                    return record

                refused = nullcontext() if operation is None else mock.patch.object(smoke.os, operation,
                    side_effect=OSError(errno.EIO, 'synthetic private body refusal', str(leaf / 'private-body-file')))
                with refused, mock.patch.object(Path, 'lstat', changed), self.assertRaises(RuntimeError) as failure:
                    smoke.check_worker_runtime_mount(root, 10001, 10001)
                self.assertEqual(str(failure.exception), 'Private worker writable fixture identity changed; cleanup was refused')
                rendered = ''.join(traceback.format_exception(failure.exception))
                self.assertNotIn(str(root), rendered)
                self.assertNotIn('synthetic private body refusal', rendered)
                self.assertEqual(len(list(leaf.iterdir())), 1)

    def test_filename_bearing_cleanup_errors_have_only_fixed_rendered_failures(self):
        for operation in ('lstat', 'unlink', 'close'):
            with self.subTest(operation=operation), self.directories() as (root, run, leaf), self.readonly(run):
                filename = str(leaf / 'private-cleanup-file')
                original_lstat, original_unlink, original_close = Path.lstat, Path.unlink, os.close

                def lstat(path):
                    if path.parent == leaf and path.name.startswith('.vectory-native-ci-leaf-'):
                        raise OSError(errno.EIO, 'synthetic private cleanup refusal', filename)
                    return original_lstat(path)

                def unlink(path, *args, **options):
                    if path.parent == leaf and path.name.startswith('.vectory-native-ci-leaf-'):
                        raise OSError(errno.EIO, 'synthetic private cleanup refusal', filename)
                    return original_unlink(path, *args, **options)

                def close(descriptor):
                    original_close(descriptor)
                    raise OSError(errno.EIO, 'synthetic private cleanup refusal', filename)

                target, name, replacement = (Path, 'lstat', lstat) if operation == 'lstat' else (
                    (Path, 'unlink', unlink) if operation == 'unlink' else (smoke.os, 'close', close))
                with mock.patch.object(target, name, replacement), self.assertRaises(RuntimeError) as failure:
                    smoke.check_worker_runtime_mount(root, 10001, 10001)
                self.assertEqual(str(failure.exception), 'Private worker runtime mount could not be safely checked')
                rendered = ''.join(traceback.format_exception(failure.exception))
                self.assertNotIn(str(root), rendered)
                self.assertNotIn('synthetic private cleanup refusal', rendered)


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
