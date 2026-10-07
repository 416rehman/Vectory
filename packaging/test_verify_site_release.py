#!/usr/bin/env python3
"""Exercise public deployment gates with synthetic metadata and a verifier stub."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('site_release', Path(__file__).with_name('verify-site-release.py'))
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class SiteReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.version = '0.2.1'
        self.commit = 'a' * 40
        self.tag_oid = 'b' * 40
        self.identity = 'https://github.com/416rehman/Vectory/.github/workflows/release.yml@refs/tags/v0.2.1'
        self.images = {'VECTORY_SERVER_IMAGE': 'ghcr.io/416rehman/vectory-server@sha256:' + '1' * 64,
                       'VECTORY_VALIDATOR_IMAGE': 'ghcr.io/416rehman/vectory-validator@sha256:' + '2' * 64}
        self.release = {'version': self.version, 'commit': self.commit, 'images': self.images,
                        'signature': {'type': 'sigstore-keyless', 'identity': self.identity,
                                      'issuer': VERIFIER.ISSUER, 'inventory': 'SHA256SUMS',
                                      'bundle': 'SHA256SUMS.sigstore.json'}}
        self.data = {name: b'synthetic prebuilt payload' for name in VERIFIER.required_files(self.version)}
        self.data['RELEASE.json'] = json.dumps(self.release).encode()
        self.data['IMAGE-DIGESTS.env'] = ''.join(name + '=' + image + '\n' for name, image in self.images.items()).encode()
        self.data['SHA256SUMS.sigstore.json'] = b'synthetic verifier-stub bundle'
        self.refresh_inventory()
        self.refresh_metadata()
        api = 'https://api.github.com/repos/416rehman/Vectory/git/'
        self.tag_url = api + 'ref/tags/v0.2.1'
        self.annotated_url = api + 'tags/' + self.tag_oid
        self.tag = {'ref': 'refs/tags/v0.2.1', 'object': {'type': 'tag', 'sha': self.tag_oid}}
        self.annotated = {'tag': 'v0.2.1', 'object': {'type': 'commit', 'sha': self.commit,
                                                   'url': api + 'commits/' + self.commit}}
        self.fetch_calls = []
        self.verifier_calls = []

    def refresh_inventory(self):
        self.data['SHA256SUMS'] = ''.join(hashlib.sha256(value).hexdigest() + '  ' + name + '\n'
                                         for name, value in sorted(self.data.items())
                                         if name not in {'SHA256SUMS', 'SHA256SUMS.sigstore.json'}).encode()

    def refresh_metadata(self):
        self.metadata = {'tag_name': 'v0.2.1', 'draft': False, 'prerelease': False,
                         'assets': [{'name': name, 'size': len(data), 'browser_download_url':
                                     'https://github.com/416rehman/Vectory/releases/download/v0.2.1/' + name}
                                    for name, data in sorted(self.data.items())]}

    def fetch(self, url, limit):
        self.fetch_calls.append(url)
        if url == self.tag_url:
            value = json.dumps(self.tag).encode()
        elif url == self.annotated_url:
            value = json.dumps(self.annotated).encode()
        else:
            value = self.data[url.rsplit('/', 1)[1]]
        self.assertLessEqual(len(value), limit)
        return value

    def verify(self, arguments, directory):
        # Cryptography is a stub here; a separate real public Cosign check covers it.
        self.verifier_calls.append(arguments)
        self.assertEqual(arguments[arguments.index('--certificate-identity') + 1], self.identity)
        self.assertEqual(arguments[arguments.index('--certificate-oidc-issuer') + 1], VERIFIER.ISSUER)
        self.assertNotIn('--certificate-identity-regexp', arguments)
        self.assertNotIn('--insecure-ignore-tlog', arguments)
        if arguments[0] == 'verify-blob':
            self.assertEqual((directory / 'SHA256SUMS').read_bytes(), self.data['SHA256SUMS'])
            self.assertEqual((directory / 'SHA256SUMS.sigstore.json').read_bytes(), self.data['SHA256SUMS.sigstore.json'])
        else:
            self.assertIn(arguments[-1], self.images.values())

    def run_gate(self, verify=None):
        return VERIFIER.verify_release(self.metadata, self.version, self.directory,
                                       fetch=self.fetch, verify=verify or self.verify)

    def test_public_release_source_is_independent_of_frontend_source(self):
        proof = self.run_gate()
        self.assertTrue(proof['ready'])
        self.assertEqual(proof['release_source_commit'], self.commit)
        self.assertEqual(proof['annotated_tag'], self.tag_oid)
        self.assertEqual([call[0] for call in self.verifier_calls], ['verify-blob', 'verify', 'verify'])
        self.assertEqual(len(self.fetch_calls), 6)

    def test_unpublished_incomplete_or_other_version_release_does_not_deploy(self):
        original = copy.deepcopy(self.metadata)
        for field, value in [('draft', True), ('prerelease', True), ('tag_name', 'v0.2.0')]:
            with self.subTest(field=field):
                self.metadata = copy.deepcopy(original)
                self.metadata[field] = value
                self.assertFalse(self.run_gate()['ready'])
        self.metadata = copy.deepcopy(original)
        self.metadata['assets'] = [asset for asset in self.metadata['assets'] if asset['name'] != 'install-native.sh']
        self.assertFalse(self.run_gate()['ready'])
        self.assertFalse(self.fetch_calls)
        self.assertFalse(self.verifier_calls)

    def test_signature_refusal_precedes_signed_metadata_and_images(self):
        def refuse(arguments, directory):
            raise ValueError('synthetic signature refusal')
        with self.assertRaisesRegex(ValueError, 'signature refusal'):
            self.run_gate(verify=refuse)
        self.assertEqual(len(self.fetch_calls), 2)

    def test_image_signature_refusal_prevents_deployment(self):
        def refuse_second(arguments, directory):
            self.verify(arguments, directory)
            if arguments[0] == 'verify':
                raise ValueError('synthetic image refusal')
        with self.assertRaisesRegex(ValueError, 'image refusal'):
            self.run_gate(verify=refuse_second)
        self.assertEqual(len(self.verifier_calls), 2)

    def test_duplicate_unsafe_offsite_and_invalid_size_assets_refused(self):
        original = copy.deepcopy(self.metadata)
        mutations = [lambda m: m['assets'].append(copy.deepcopy(m['assets'][0])),
                     lambda m: m['assets'][0].update(name='../payload'),
                     lambda m: m['assets'][0].update(browser_download_url='https://example.invalid/payload'),
                     lambda m: m['assets'][0].update(size=True),
                     lambda m: m['assets'][0].update(size=0)]
        for mutate in mutations:
            self.metadata = copy.deepcopy(original)
            mutate(self.metadata)
            with self.subTest(mutate=mutate):
                with self.assertRaises(ValueError):
                    self.run_gate()
        self.assertFalse(self.fetch_calls)

    def test_signature_metadata_size_and_publication_types_refused(self):
        original = copy.deepcopy(self.metadata)
        self.metadata['assets'][next(i for i, a in enumerate(self.metadata['assets'])
                                    if a['name'] == 'SHA256SUMS')]['size'] = VERIFIER.METADATA_LIMIT + 1
        with self.assertRaisesRegex(ValueError, 'bound'):
            self.run_gate()
        for value in ('false', 0, None):
            self.metadata = copy.deepcopy(original)
            self.metadata['draft'] = value
            with self.assertRaisesRegex(ValueError, 'state'):
                self.run_gate()

    def test_signed_inventory_refuses_duplicate_unsafe_missing_and_extra_entries(self):
        names = set(self.data)
        original = self.data['SHA256SUMS']
        cases = [original + original.splitlines(True)[0],
                 original + b'0' * 64 + b'  ../payload\n',
                 b'\n'.join(original.splitlines()[1:]) + b'\n',
                 original + b'0' * 64 + b'  extra.bin\n', b'\xff']
        for data in cases:
            with self.subTest(data_length=len(data)):
                with self.assertRaises(ValueError):
                    VERIFIER.checked_inventory(data, names)

    def test_signed_metadata_digest_mismatch_refused(self):
        for name in ('RELEASE.json', 'IMAGE-DIGESTS.env'):
            original = self.data[name]
            self.data[name] = original.replace(b'0.2.1', b'0.2.9') if name == 'RELEASE.json' else original.replace(b'1', b'9', 1)
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'signed inventory'):
                    self.run_gate()
            self.data[name] = original

    def test_authenticated_wrong_release_identity_version_or_commit_refused(self):
        original = copy.deepcopy(self.release)
        mutations = [lambda d: d.update(version='0.2.0'), lambda d: d.update(commit='invalid'),
                     lambda d: d['signature'].update(issuer='https://example.invalid'),
                     lambda d: d['signature'].update(identity=self.identity.replace('v0.2.1', 'main'))]
        for mutate in mutations:
            self.release = copy.deepcopy(original)
            mutate(self.release)
            self.data['RELEASE.json'] = json.dumps(self.release).encode()
            self.refresh_inventory()
            self.refresh_metadata()
            with self.subTest(mutate=mutate):
                with self.assertRaises(ValueError):
                    self.run_gate()

    def test_wrong_lightweight_malformed_or_mismatched_tag_refused(self):
        original_tag, original_annotated = copy.deepcopy(self.tag), copy.deepcopy(self.annotated)
        for field, value in [('type', 'commit'), ('sha', 'invalid')]:
            self.tag = copy.deepcopy(original_tag)
            self.tag['object'][field] = value
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    self.run_gate()
        self.tag = original_tag
        for field, value in [('type', 'tag'), ('sha', 'c' * 40), ('url', 'https://example.invalid')]:
            self.annotated = copy.deepcopy(original_annotated)
            self.annotated['object'][field] = value
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, 'signed source commit'):
                    self.run_gate()
        for attribute in ('tag', 'annotated'):
            self.tag, self.annotated = original_tag, original_annotated
            setattr(self, attribute, [])
            with self.assertRaisesRegex(ValueError, 'shape'):
                self.run_gate()

    def test_mutable_duplicate_wrong_repository_or_disagreeing_image_refs_refused(self):
        original = self.data['IMAGE-DIGESTS.env']
        for data in [original.replace(b'@sha256:' + b'1' * 64, b':latest'),
                     original + original.splitlines(True)[0],
                     original.replace(b'416rehman/vectory-server', b'other/vectory-server'),
                     original.replace(b'1' * 64, b'3' * 64)]:
            self.data['IMAGE-DIGESTS.env'] = data
            self.refresh_inventory()
            self.refresh_metadata()
            with self.subTest(data_length=len(data)):
                with self.assertRaises(ValueError):
                    self.run_gate()

    def test_invalid_version_json_and_encoding_refused(self):
        for version in ('0.2.1-dev', 'refs/tags/v0.2.1', '0.02.1', '../0.2.1'):
            with self.assertRaisesRegex(ValueError, 'stable version'):
                VERIFIER.verify_release(self.metadata, version, self.directory)
        for raw in (b'\xff', b'{invalid'):
            with self.assertRaisesRegex(ValueError, 'UTF-8 JSON'):
                VERIFIER.json_document(raw)

    def test_cosign_failure_timeout_and_error_output_are_not_reported(self):
        for failure in [OSError('synthetic credential-bearing failure'),
                        subprocess.TimeoutExpired('synthetic private command', 90)]:
            with mock.patch.object(VERIFIER.subprocess, 'run', side_effect=failure):
                with self.assertRaisesRegex(ValueError, '^Public release signature verifier was unavailable$') as caught:
                    VERIFIER.cosign_verify(['verify'], self.directory)
                self.assertTrue(caught.exception.__suppress_context__)
        for result in [subprocess.CompletedProcess([], 1, b'private fixture', b'private fixture'),
                       subprocess.CompletedProcess([], 0, b'x' * (1024 * 1024 + 1), b'')]:
            with mock.patch.object(VERIFIER.subprocess, 'run', return_value=result):
                with self.assertRaises(ValueError) as caught:
                    VERIFIER.cosign_verify(['verify'], self.directory)
                self.assertNotIn('private fixture', str(caught.exception))

    def test_cosign_uses_empty_registry_credentials_and_private_verifier_cache(self):
        with mock.patch.dict(os.environ, {'GH_TOKEN': 'synthetic secret', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN': 'synthetic secret'}):
            with mock.patch.object(VERIFIER.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')) as run:
                VERIFIER.cosign_verify(['verify'], self.directory)
        args, kwargs = run.call_args
        self.assertEqual(args[0], ['cosign', 'verify'])
        self.assertNotIn('GH_TOKEN', kwargs['env'])
        self.assertNotIn('ACTIONS_ID_TOKEN_REQUEST_TOKEN', kwargs['env'])
        self.assertEqual(Path(kwargs['env']['DOCKER_CONFIG']), self.directory / 'anonymous-docker')
        self.assertFalse(list((self.directory / 'anonymous-docker').iterdir()))
        self.assertEqual(kwargs['timeout'], 90)

    def test_public_fetch_checks_https_redirects_bounds_and_timeout(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.url = 'https://release-assets.githubusercontent.com/synthetic-payload'
        response.read.return_value = b'bounded metadata'
        with mock.patch.object(VERIFIER.urllib.request, 'urlopen', return_value=response) as opened:
            self.assertEqual(VERIFIER.fetch_bytes('https://github.com/416rehman/Vectory', 32),
                             b'bounded metadata')
        self.assertEqual(opened.call_args.kwargs['timeout'], 20)
        response.read.assert_called_once_with(33)
        for url in ('https://example.invalid/redirect', 'http://github.com/payload'):
            response.url = url
            with mock.patch.object(VERIFIER.urllib.request, 'urlopen', return_value=response):
                with self.assertRaisesRegex(ValueError, '^Could not read bounded public release metadata$'):
                    VERIFIER.fetch_bytes('https://github.com/416rehman/Vectory', 32)
        response.url = 'https://github.com/payload'
        response.read.return_value = b'x' * 33
        with mock.patch.object(VERIFIER.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(ValueError, 'bound'):
                VERIFIER.fetch_bytes('https://github.com/416rehman/Vectory', 32)
        with mock.patch.object(VERIFIER.urllib.request, 'urlopen', side_effect=OSError('private fixture')):
            with self.assertRaises(ValueError) as caught:
                VERIFIER.fetch_bytes('https://github.com/416rehman/Vectory', 32)
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertNotIn('private fixture', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
