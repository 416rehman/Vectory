"""Native payload and corresponding-source negative fixtures; no real install."""
import hashlib
import importlib.util
import copy
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load('native_builder', 'build-native-kit.py')
sources = load('native_sources', 'build-native-runtime-source.py')
verifier = load('release_verifier', 'verify-release.py')


class NativeImageIdentityTests(unittest.TestCase):
    def image(self, directory, storage='manifest', architecture='amd64', user='10001:10001', attack=None, omit_user=False):
        configuration = {'architecture': architecture, 'os': 'linux', 'config': {} if omit_user else {'User': user},
                         'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + 'a' * 64]}}
        config_bytes = json.dumps(configuration, sort_keys=True).encode()
        config_id = 'sha256:' + hashlib.sha256(config_bytes).hexdigest()
        config_path = 'blobs/sha256/' + config_id.removeprefix('sha256:')
        layer_path = 'layer/layer.tar'
        members = {config_path: config_bytes, layer_path: b'synthetic layer fixture'}
        if storage == 'classic':
            execution_id = config_id
        else:
            manifest = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                        'config': {'mediaType': 'application/vnd.oci.image.config.v1+json',
                                   'digest': config_id, 'size': len(config_bytes)},
                        'layers': [{'mediaType': 'application/vnd.oci.image.layer.v1.tar',
                                    'digest': 'sha256:' + 'a' * 64, 'size': len(members[layer_path])}]}
            if attack == 'different_config':
                manifest['config']['digest'] = 'sha256:' + 'b' * 64
            manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
            manifest_id = 'sha256:' + hashlib.sha256(manifest_bytes).hexdigest()
            members['blobs/sha256/' + manifest_id.removeprefix('sha256:')] = manifest_bytes
            descriptor = {'mediaType': manifest['mediaType'], 'digest': manifest_id, 'size': len(manifest_bytes)}
            if attack == 'wrong_size':
                descriptor['size'] += 1
            if attack == 'changed_blob':
                members['blobs/sha256/' + manifest_id.removeprefix('sha256:')] += b' '
            execution_id = manifest_id
            if storage == 'index':
                descriptor['platform'] = {'os': 'linux', 'architecture': 'amd64'}
                children = [descriptor]
                if attack == 'ambiguous_platform':
                    children.append(copy.deepcopy(descriptor))
                index = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                         'manifests': children + [{'mediaType': manifest['mediaType'], 'digest': 'sha256:' + 'c' * 64,
                             'size': 100, 'platform': {'os': 'linux', 'architecture': 'arm64'}}]}
                index_bytes = json.dumps(index, sort_keys=True).encode()
                execution_id = 'sha256:' + hashlib.sha256(index_bytes).hexdigest()
                members['blobs/sha256/' + execution_id.removeprefix('sha256:')] = index_bytes
                descriptor = {'mediaType': index['mediaType'], 'digest': execution_id, 'size': len(index_bytes)}
            members['index.json'] = json.dumps({'schemaVersion': 2, 'manifests': [descriptor]}).encode()
            members['oci-layout'] = b'{"imageLayoutVersion":"1.0.0"}'
        members['manifest.json'] = json.dumps([{'Config': config_path, 'Layers': [layer_path],
                                                'RepoTags': ['vectory-server:candidate']}]).encode()
        path = directory / 'vectory-server-image.tar.gz'
        with tarfile.open(path, mode='w:gz') as archive:
            for name, data in members.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        inspect = {'Id': execution_id, 'Architecture': architecture, 'Os': 'linux',
                   'Config': {'User': user}, 'RootFS': {'Type': 'layers', 'Layers': configuration['rootfs']['diff_ids']},
                   'RepoTags': ['vectory-server:candidate']}
        return path, config_id, inspect

    def test_config_digest_and_execution_identity_are_distinct_and_bound_for_all_stores(self):
        for storage in ('classic', 'manifest', 'index'):
            with self.subTest(storage=storage), tempfile.TemporaryDirectory() as temporary:
                path, config_id, inspect = self.image(Path(temporary), storage)
                with mock.patch.object(builder, 'command', return_value=json.dumps([inspect])) as command:
                    proof = builder.image_identity('vectory-server:candidate', '10001:10001', path, 'vectory-server:candidate')
                self.assertEqual(proof['config_id'], config_id)
                self.assertEqual(proof['execution_id'], inspect['Id'])
                self.assertEqual(command.call_count, 1)  # inspect only; no container activation
                if storage != 'classic':
                    self.assertNotEqual(proof['config_id'], proof['execution_id'])
                records = [inspect, {'RepoTags': ['vectory-validator:candidate']}]
                verifier.native_candidate_image_identity(Path(temporary), 'server', proof, records)
                for key in ('config_id', 'execution_id'):
                    changed = dict(proof, **{key: 'sha256:' + 'f' * 64})
                    with self.subTest(changed_identity=key), self.assertRaises(ValueError):
                        verifier.native_candidate_image_identity(Path(temporary), 'server', changed, records)

    def test_unbound_execution_wrong_rootfs_platform_or_user_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, _, inspect = self.image(Path(temporary))
            attacks = [dict(inspect, Id='sha256:' + 'f' * 64), dict(inspect, Architecture='arm64'),
                       dict(inspect, Config={'User': '0:0'}),
                       dict(inspect, RootFS={'Type': 'layers', 'Layers': ['sha256:' + 'd' * 64]})]
            for changed in attacks:
                with self.subTest(changed=changed), mock.patch.object(builder, 'command', return_value=json.dumps([changed])), self.assertRaises(ValueError):
                    builder.image_identity('vectory-server:candidate', '10001:10001', path, 'vectory-server:candidate')

    def test_oci_descriptor_digest_size_config_and_platform_ambiguity_fail_closed(self):
        for storage, attack in (('manifest', 'changed_blob'), ('manifest', 'wrong_size'),
                               ('manifest', 'different_config'), ('index', 'ambiguous_platform')):
            with self.subTest(attack=attack), tempfile.TemporaryDirectory() as temporary:
                path, _, _ = self.image(Path(temporary), storage, attack=attack)
                with self.assertRaises(ValueError):
                    verifier.required_image(path, 'vectory-server:candidate', identity=True)

    def test_saved_config_and_bounded_metadata_cannot_be_replaced_by_inspect_labels(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, _, inspect = self.image(Path(temporary), architecture='arm64')
            inspect['Architecture'] = 'amd64'
            with mock.patch.object(builder, 'command', return_value=json.dumps([inspect])), self.assertRaises(ValueError):
                builder.image_identity('vectory-server:candidate', '10001:10001', path, 'vectory-server:candidate')
            path, _, _ = self.image(Path(temporary))
            with mock.patch.object(verifier, 'MAX_IMAGE_IDENTITY_BYTES', 64), self.assertRaises(ValueError):
                verifier.required_image(path, 'vectory-server:candidate', identity=True)


class NativeExtractionTests(unittest.TestCase):
    def test_dependency_closure_requires_actual_reviewed_loader_and_resolved_paths(self):
        text = '''linux-vdso.so.1 (0x0000)
libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x1234)
/lib64/ld-linux-x86-64.so.2 (0x5678)'''
        self.assertEqual(builder.dependency_paths(text), {'/lib/x86_64-linux-gnu/libc.so.6', '/lib64/ld-linux-x86-64.so.2'})
        for unsafe in ('libc.so.6 => not found', text.replace('/lib/x86_64-linux-gnu/', '/home/'), text.replace('/lib64/ld-linux-x86-64.so.2', '/lib64/different-loader')):
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                builder.dependency_paths(unsafe)

    def test_native_elf_rejects_foreign_or_short_binaries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'binary'
            valid = bytearray(64)
            valid[:6] = b'\x7fELF\x02\x01'
            valid[18:20] = (62).to_bytes(2, 'little')
            path.write_bytes(valid)
            builder.elf64(path)
            for invalid in (b'not executable', valid[:20], valid[:18] + b'\xb7\x00' + valid[20:]):
                path.write_bytes(invalid)
                with self.assertRaises(ValueError):
                    builder.elf64(path)

    def test_payload_rejects_special_names_and_links_without_following_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'file').write_text('payload')
            self.assertEqual(len(builder.safe_files(root)), 1)
            (root / 'bad name').write_text('payload')
            with self.assertRaises(ValueError):
                builder.safe_files(root)
            (root / 'bad name').unlink()
            try:
                (root / 'link').symlink_to(root / 'file')
            except OSError:
                self.skipTest('Host does not permit symlink creation; Linux CI runs this case')
            with self.assertRaises(ValueError):
                builder.safe_files(root)

    def test_native_requirement_preserves_historical_release_shapes(self):
        self.assertFalse(verifier.has_native_server('0.2.0'))
        self.assertFalse(verifier.has_native_server('0.1.1'))
        self.assertTrue(verifier.has_native_server('0.2.1'))


class CorrespondingSourceTests(unittest.TestCase):
    def index(self, name='glibc_2.41.dsc', release='2.41-1'):
        return f'Package: glibc\nVersion: {release}\nChecksums-Sha256:\n {"a" * 64} 12 {name}\n {"b" * 64} 24 glibc_2.41.orig.tar.xz\n\n'

    def test_exact_source_version_and_sha256_inventory_are_retained(self):
        records = sources.source_records(self.index(), {('glibc', '2.41-1')})
        self.assertEqual(records[('glibc', '2.41-1')][0], {'name': 'glibc_2.41.dsc', 'bytes': 12, 'sha256': 'a' * 64})
        self.assertEqual(len(records[('glibc', '2.41-1')]), 2)

    def test_wrong_versions_missing_descriptors_and_unsafe_source_paths_fail_closed(self):
        for index in (self.index(release='2.41-2'), self.index(name='../glibc.dsc'),
                      self.index(name='glibc.tar.gz'), self.index().replace('a' * 64, 'not-a-digest'),
                      self.index().replace(' 12 ', ' -12 ')):
            with self.subTest(index=index), self.assertRaises(ValueError):
                sources.source_records(index, {('glibc', '2.41-1')})

    def test_conflicting_authenticated_source_stanzas_are_rejected(self):
        with self.assertRaises(ValueError):
            sources.source_records(self.index() + self.index().replace('a' * 64, 'c' * 64), {('glibc', '2.41-1')})


class DefaultUserIdentityTests(unittest.TestCase):
    def test_classic_empty_and_containerd_omitted_default_users_match_only_each_other(self):
        fixture = NativeImageIdentityTests()
        for omit_saved, inspect_user in ((True, {'User': ''}), (False, {})):
            with self.subTest(omit_saved=omit_saved), tempfile.TemporaryDirectory() as temporary:
                path, config_id, inspect = fixture.image(Path(temporary), storage='classic', user='', omit_user=omit_saved)
                inspect['Config'] = inspect_user
                with mock.patch.object(builder, 'command', return_value=json.dumps([inspect])):
                    proof = builder.image_identity('synthetic-default-user-image', archive_path=path,
                                                   expected_tag='vectory-server:candidate')
                self.assertEqual(proof['config_id'], config_id)
                self.assertEqual(proof['execution_id'], inspect['Id'])
                for user in ('10001:10001', '0:0', None, 1, [], {}):
                    changed = dict(inspect, Config={'User': user})
                    with self.subTest(user=user), mock.patch.object(builder, 'command', return_value=json.dumps([changed])), self.assertRaises(ValueError):
                        builder.image_identity('synthetic-default-user-image', archive_path=path,
                                               expected_tag='vectory-server:candidate')

    def test_matching_non_string_users_are_not_accepted_as_default_or_explicit_users(self):
        fixture = NativeImageIdentityTests()
        for user in (None, 1, [], {}):
            with self.subTest(user=user), tempfile.TemporaryDirectory() as temporary:
                path, _, inspect = fixture.image(Path(temporary), storage='classic', user=user)
                with mock.patch.object(builder, 'command', return_value=json.dumps([inspect])), self.assertRaises(ValueError):
                    builder.image_identity('synthetic-invalid-user-image', archive_path=path,
                                           expected_tag='vectory-server:candidate')


if __name__ == '__main__':
    unittest.main()
