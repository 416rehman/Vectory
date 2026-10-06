"""Bounded native license extraction fixtures; no real service installation."""
import importlib.util
from pathlib import Path
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('native_license_builder', Path(__file__).with_name('build-native-kit.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def entry(kind, name, target=''):
    return '\t'.join((kind, name, target, '.'))


class NativeLicenseExtractionTests(unittest.TestCase):
    def test_direct_regular_files_and_aliases_are_copied_individually_from_the_same_image(self):
        image = 'sha256:' + 'a' * 64
        listing = '\n'.join((entry('l', 'GPL', 'GPL-3'), entry('f', 'GPL-3'),
                              entry('f', 'Apache-2.0')))
        copy = mock.Mock()
        with mock.patch.object(builder, 'image_run', return_value=listing) as run:
            builder.copy_common_licenses(image, copy)
        run.assert_called_once_with(image, '/usr/bin/find', '/usr/share/common-licenses',
                                    '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\t%f\t%l\t.\n')
        self.assertEqual(copy.call_args_list, [mock.call('/usr/share/common-licenses/Apache-2.0', 'Apache-2.0'),
                                              mock.call('/usr/share/common-licenses/GPL-3', 'GPL'),
                                              mock.call('/usr/share/common-licenses/GPL-3', 'GPL-3')])

    def test_invalid_listings_are_refused_before_any_file_copy(self):
        regular = entry('f', 'GPL-3')
        attacks = ('', 'f\tGPL-3\t', entry('d', 'subdirectory'), entry('p', 'fifo'),
                   entry('s', 'socket'), entry('f', 'bad name'), entry('f', '../outside'),
                   entry('f', '/absolute'), entry('f', '.hidden'), entry('f', 'x' * 121),
                   regular + '\n' + regular, entry('f', 'GPL-3', 'unexpected'),
                   entry('l', 'GPL', '../outside'), entry('l', 'GPL', '/absolute'),
                   entry('l', 'GPL', 'subdir/GPL-3'), entry('l', 'GPL', ''),
                   entry('l', 'GPL', 'missing'), entry('l', 'GPL', 'GPL'),
                   entry('l', 'GPL', 'alias') + '\n' + entry('l', 'alias', 'GPL-3') + '\n' + regular,
                   entry('l', 'GPL', 'alias') + '\n' + entry('l', 'alias', 'GPL'),
                   '\n'.join(entry('f', 'file-' + str(n)) for n in range(257)),
                   entry('f', 'GPL-3') + '\n' + 'x' * (64 * 1024))
        for listing in attacks:
            with self.subTest(listing=listing[:100]), mock.patch.object(builder, 'image_run', return_value=listing):
                copy = mock.Mock()
                with self.assertRaises(ValueError):
                    builder.copy_common_licenses('sha256:' + 'a' * 64, copy)
                copy.assert_not_called()

    def test_helper_keeps_immutable_image_and_network_filesystem_resource_guards(self):
        image = 'sha256:' + 'a' * 64
        with mock.patch.object(builder, 'command', return_value=entry('f', 'MIT')) as command:
            builder.copy_common_licenses(image, mock.Mock())
        command.assert_called_once_with('docker', 'run', '--platform', 'linux/amd64', '--pull', 'never',
            '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt',
            'no-new-privileges:true', '--memory', '256m', '--pids-limit', '32', '--entrypoint',
            '/usr/bin/find', image, '/usr/share/common-licenses', '-mindepth', '1', '-maxdepth', '1',
            '-printf', '%y\t%f\t%l\t.\n')


if __name__ == '__main__':
    unittest.main()
