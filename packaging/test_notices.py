import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location('notices', Path(__file__).with_name('generate-notices.py'))
notices = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notices)


class NoticeTests(unittest.TestCase):
    def fixture(self):
        directory = tempfile.TemporaryDirectory(prefix='vectory-notice-test-')
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        data = root / 'packaging/notices'
        (data / 'texts').mkdir(parents=True)
        (root / 'deploy').mkdir()
        (root / 'deploy/Dockerfile').write_text('FROM golang:test AS agents\nFROM rust:test AS server\n')
        (root / 'lock').write_bytes(b'pinned input\n')
        text = b'Copyright Test Author\nPermission notice and disclaimer.\n'
        digest = hashlib.sha256(text).hexdigest()
        (data / 'texts' / (digest + '.txt')).write_bytes(text)
        record = {'section': 'npm-dashboard', 'name': 'example', 'version': '1.0.0', 'file': 'LICENSE', 'source': 'https://example.invalid/pinned', 'sha256': digest, 'text': 'texts/' + digest + '.txt'}
        manifest = {'schema': 1, 'inputs': {'lock': hashlib.sha256(b'pinned input\n').hexdigest()},
                    'toolchains': {'go': {'image': 'golang:test'}, 'rust': {'image': 'rust:test'}},
                    'scope': {'cargo-linux-normal-build': [], 'npm-dashboard': {'app': ['example'], 'designer': []}, 'npm-help-center': [], 'go-agent': [], 'go-runtime': [], 'rust-runtime': []},
                    'records': [record]}
        (data / 'manifest.json').write_text(json.dumps(manifest))
        return root, data, manifest, record

    def test_current_distribution_is_exact_and_preserves_copyright(self):
        rendered = notices.render()
        self.assertEqual(rendered, (notices.ROOT / 'NOTICE').read_bytes())
        self.assertIn(b'Copyright (c) Meta Platforms, Inc. and affiliates.', rendered)
        self.assertIn(b'GNU GENERAL PUBLIC LICENSE', rendered)
        self.assertIn(b'Copyright 2009 The Go Authors.', rendered)

    def test_changed_license_text_is_rejected(self):
        root, data, _, record = self.fixture()
        (data / record['text']).write_bytes(b'Copyright statement removed.\n')
        with self.assertRaisesRegex(ValueError, 'source digest mismatch'):
            notices.render(root, data)

    def test_changed_dependency_input_is_rejected(self):
        root, data, _, _ = self.fixture()
        (root / 'lock').write_bytes(b'new dependency\n')
        with self.assertRaisesRegex(ValueError, 'input changed'):
            notices.render(root, data)

    def test_compiler_image_upgrade_requires_notice_refresh(self):
        root, data, _, _ = self.fixture()
        (root / 'deploy/Dockerfile').write_text('FROM golang:new\nFROM rust:test\n')
        with self.assertRaisesRegex(ValueError, 'toolchain changed'):
            notices.render(root, data)

    def test_missing_component_text_is_rejected(self):
        root, data, manifest, _ = self.fixture()
        manifest['records'] = []
        (data / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'Missing browser notice'):
            notices.render(root, data)

    def test_source_path_cannot_escape_snapshot_directory(self):
        root, data, manifest, _ = self.fixture()
        manifest['records'][0]['text'] = '../../outside.txt'
        (data / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'escaped source directory'):
            notices.render(root, data)


if __name__ == '__main__':
    unittest.main()
