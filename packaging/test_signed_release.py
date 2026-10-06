import importlib.util
import json
import hashlib
import io
from pathlib import Path
import tempfile
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('prepare-signed-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class SignedReleaseTests(unittest.TestCase):
    def test_portable_config_identity_is_hashed_from_the_actual_saved_json(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            expected = {}
            for component in ('server', 'validator'):
                config = json.dumps({'architecture': 'amd64', 'os': 'linux', 'component': component}).encode()
                digest = hashlib.sha256(config).hexdigest()
                expected[component] = 'sha256:' + digest
                name = 'blobs/sha256/' + digest
                parts = {name: config, 'manifest.json': json.dumps([{'RepoTags': ['vectory-' + component + ':candidate'], 'Config': name}]).encode()}
                with tarfile.open(folder / ('vectory-' + component + '-image.tar.gz'), 'w:gz') as archive:
                    for path, payload in parts.items():
                        member = tarfile.TarInfo(path)
                        member.size = len(payload)
                        archive.addfile(member, io.BytesIO(payload))
            self.assertEqual(release.write_image_configs(folder), expected)
            self.assertIn(expected['server'], (folder / 'IMAGE-CONFIGS.env').read_text())
    def test_local_image_configs_require_both_exact_unique_candidate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'images.json'
            valid = [{'RepoTags': ['vectory-' + component + ':candidate'], 'Id': 'sha256:' + digit * 64}
                     for component, digit in (('server', 'a'), ('validator', 'b'))]
            path.write_text(json.dumps(valid))
            self.assertEqual(release.checked_image_configs(path), {'server': 'sha256:' + 'a' * 64, 'validator': 'sha256:' + 'b' * 64})
            for invalid in ([valid[0], valid[0]], [{'RepoTags': ['vectory-server:candidate'], 'Id': 'mutable'}, valid[1]], valid[:1]):
                path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    release.checked_image_configs(path)
    def test_only_exact_stable_tag_is_accepted(self):
        self.assertEqual(release.stable_tag('refs/tags/v0.2.0', '0.2.0'), 'v0.2.0')
        for ref in ('refs/heads/main', 'refs/tags/v0.2.0-dev', 'refs/tags/v0.2.1', 'refs/tags/v0.2.0/evil'):
            with self.assertRaises(ValueError): release.stable_tag(ref, '0.2.0')

    def test_registry_inventory_refuses_mutable_external_and_repeated_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'images'
            lines = ['VECTORY_SERVER_IMAGE=ghcr.io/416rehman/vectory-server@sha256:' + 'a' * 64,
                     'VECTORY_VALIDATOR_IMAGE=ghcr.io/416rehman/vectory-validator@sha256:' + 'b' * 64]
            path.write_text('\n'.join(lines) + '\n')
            self.assertEqual(len(release.checked_images(path)), 2)
            for text in (lines[0], '\n'.join(lines + [lines[0]]), '\n'.join(lines).replace('ghcr.io', 'attacker.invalid'), '\n'.join(lines).replace('@sha256:' + 'a' * 64, ':latest')):
                path.write_text(text)
                with self.assertRaises(ValueError): release.checked_images(path)

    def test_critical_blocks_even_without_fix_high_with_fix_blocks(self):
        for severity, fixed in (('CRITICAL', ''), ('HIGH', '2.0')):
            with self.assertRaises(ValueError):
                release.scan_findings({'SchemaVersion': 2, 'Results': [{'Vulnerabilities': [{'Severity': severity, 'FixedVersion': fixed, 'VulnerabilityID': 'CVE-example', 'PkgName': 'example'}]}]})
        self.assertEqual(release.scan_findings({'SchemaVersion': 2, 'Results': [{'Vulnerabilities': [{'Severity': 'HIGH', 'FixedVersion': ''}]}]}), {'HIGH': 1})
        with self.assertRaises(ValueError): release.scan_findings({'Results': []})

    def test_signature_bundle_is_excluded_from_signed_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            for name in ('IMAGE-DIGESTS.env', 'SHA256SUMS', 'SHA256SUMS.sigstore.json'):
                (folder / name).write_text('test')
            self.assertEqual(release.inventory(folder), '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  IMAGE-DIGESTS.env\n')


if __name__ == '__main__': unittest.main()
