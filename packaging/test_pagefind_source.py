import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('pagefind_source', Path(__file__).with_name('build-pagefind-source.py'))
source = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source)


class PagefindSourceTests(unittest.TestCase):
    def fixture(self):
        directory = tempfile.TemporaryDirectory(prefix='vectory-pagefind-source-test-')
        self.addCleanup(directory.cleanup)
        dest = Path(directory.name)
        for name in (source.ARCHIVE, source.MANIFEST):
            (dest / name).write_bytes((source.DEST / name).read_bytes())
        return dest

    def test_complete_shipped_archive_verifies_offline(self):
        manifest = source.check()
        self.assertEqual(len(manifest['source_inputs']), 23)
        self.assertEqual(len(manifest['ui_source_inputs']), 5)
        self.assertFalse(manifest['build_verification']['upstream_packaged_wasm_byte_equivalence'].startswith('Verified'))

    def test_corrupt_source_archive_is_rejected(self):
        dest = self.fixture()
        data = bytearray((dest / source.ARCHIVE).read_bytes())
        data[-20] ^= 1
        (dest / source.ARCHIVE).write_bytes(data)
        with patch.object(source, 'DEST', dest):
            with self.assertRaisesRegex(ValueError, 'archive checksum mismatch'):
                source.check()

    def test_omitted_ui_source_input_is_rejected(self):
        dest = self.fixture()
        manifest = json.loads((dest / source.MANIFEST).read_text())
        manifest['ui_source_inputs'].pop()
        (dest / source.MANIFEST).write_text(json.dumps(manifest))
        with patch.object(source, 'DEST', dest):
            with self.assertRaisesRegex(ValueError, 'input manifest mismatch'):
                source.check()

    def test_lockfile_package_integrity_cannot_be_relabelled(self):
        dest = self.fixture()
        manifest = json.loads((dest / source.MANIFEST).read_text())
        manifest['source_inputs'][0]['sha256'] = '0' * 64
        (dest / source.MANIFEST).write_text(json.dumps(manifest))
        with patch.object(source, 'DEST', dest):
            with self.assertRaisesRegex(ValueError, 'input manifest mismatch'):
                source.check()

    def test_parent_traversal_from_downloaded_source_is_rejected(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            entry = tarfile.TarInfo('package/../../outside')
            entry.size = 1
            archive.addfile(entry, io.BytesIO(b'x'))
        with self.assertRaisesRegex(ValueError, 'Unsafe source member'):
            source.unpack(buffer.getvalue(), 'package')

    def test_source_symlink_cannot_escape_tree(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            entry = tarfile.TarInfo('package/LICENSE')
            entry.type = tarfile.SYMTYPE
            entry.linkname = '../../outside'
            archive.addfile(entry)
        with self.assertRaisesRegex(ValueError, 'symlink escaped tree'):
            source.unpack(buffer.getvalue(), 'package')


if __name__ == '__main__':
    unittest.main()
