import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest
import zlib

SPEC = importlib.util.spec_from_file_location('profiles', Path(__file__).with_name('verify-pagefind-profiles.py'))
profiles = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(profiles)


class PagefindProfileTests(unittest.TestCase):
    def fixture(self):
        raw = b'pagefind_dcd\0asm\x01\0\0\0'
        compressed = zlib.compress(raw, wbits=31)
        binary = b'prefix' + compressed + b'suffix'
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            entry = tarfile.TarInfo('package/bin/pagefind')
            entry.size = len(binary)
            archive.addfile(entry, io.BytesIO(binary))
        data = stream.getvalue()
        native = {'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode(), 'sha256': profiles.sha(data), 'bytes': len(data), 'binary': 'bin/pagefind', 'binary_sha256': profiles.sha(binary)}
        wasm = {'filename': 'wasm.en.pagefind', 'native_binary_offset': 6, 'bytes': len(compressed), 'sha256': profiles.sha(compressed), 'uncompressed_sha256': profiles.sha(raw), 'uncompressed_bytes': len(raw), 'decoded_wasm_sha256': profiles.sha(raw[12:]), 'decoded_wasm_bytes': len(raw[12:])}
        return {'native_package': native, 'wasm': [wasm]}, data

    def test_seven_locked_profiles_verify_offline(self):
        found = profiles.verify()
        self.assertEqual(set(found), profiles.KEYS)

    def test_native_archive_and_embedded_decoded_module_verify(self):
        profile, data = self.fixture()
        profiles.check_native_archive(profile, data)

    def test_changed_native_archive_is_rejected(self):
        profile, data = self.fixture()
        with self.assertRaisesRegex(ValueError, 'archive integrity'):
            profiles.check_native_archive(profile, data + b'changed')

    def test_changed_embedded_compressed_pin_is_rejected(self):
        profile, data = self.fixture()
        profile['wasm'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'compressed WASM'):
            profiles.check_native_archive(profile, data)

    def test_changed_decoded_module_pin_is_rejected(self):
        profile, data = self.fixture()
        profile['wasm'][0]['decoded_wasm_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Decoded WASM'):
            profiles.check_native_archive(profile, data)

    def test_wrong_publisher_source_commit_is_rejected(self):
        statement = {'predicate': {'buildDefinition': {'resolvedDependencies': [{'uri': 'git+https://github.com/Pagefind/pagefind@refs/heads/main', 'digest': {'gitCommit': '0' * 40}}]}}}
        document = {'dsseEnvelope': {'payload': base64.b64encode(json.dumps(statement).encode()).decode()}}
        with self.assertRaisesRegex(ValueError, 'source commit'):
            profiles.published_source_commit(document)


if __name__ == '__main__':
    unittest.main()
