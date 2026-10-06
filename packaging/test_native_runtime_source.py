"""Verified source ownership and permissions fixtures; no service installation."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('native_runtime_source_handoff', Path(__file__).with_name('build-native-runtime-source.py'))
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class NativeRuntimeSourceHandoffTests(unittest.TestCase):
    def test_only_host_owner_sets_mode_after_the_checked_helper_succeeds(self):
        arguments = ['docker', 'run', 'synthetic-source-fetch']
        destination = mock.Mock()
        order = mock.Mock()
        with mock.patch.object(sources.subprocess, 'run') as run:
            order.attach_mock(run, 'fetch')
            order.attach_mock(destination.chmod, 'host_mode')
            sources.fetch_authenticated_sources(arguments, destination)
        self.assertEqual(order.mock_calls, [mock.call.fetch(arguments, check=True, timeout=600,
                                                             stdout=subprocess.DEVNULL),
                                            mock.call.host_mode(0o755)])

    def test_failed_or_timed_out_authentication_cannot_trigger_host_mode_change(self):
        arguments = ['docker', 'run', 'synthetic-source-fetch']
        for error in (subprocess.CalledProcessError(1, arguments), subprocess.TimeoutExpired(arguments, 600)):
            with self.subTest(error=type(error).__name__), mock.patch.object(sources.subprocess, 'run', side_effect=error):
                destination = mock.Mock()
                with self.assertRaises(type(error)):
                    sources.fetch_authenticated_sources(arguments, destination)
                destination.chmod.assert_not_called()

    def test_host_mode_failure_is_not_swallowed_or_retried_with_more_privileges(self):
        destination = mock.Mock()
        destination.chmod.side_effect = PermissionError('Synthetic source permissions failure')
        with mock.patch.object(sources.subprocess, 'run') as run, self.assertRaises(PermissionError):
            sources.fetch_authenticated_sources(['synthetic-source-fetch'], destination)
        run.assert_called_once()
        destination.chmod.assert_called_once_with(0o755)


if __name__ == '__main__':
    unittest.main()
