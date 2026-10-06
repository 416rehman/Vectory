"""Native evidence and manifest fixtures; installer scripts stay as data."""
from contextlib import ExitStack, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('verify_native_evidence', ROOT / 'packaging/verify-release.py')
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)
PRODUCER_SPEC = importlib.util.spec_from_file_location('native_candidate_producer', ROOT / 'packaging/candidate-manifest.py')
producer = importlib.util.module_from_spec(PRODUCER_SPEC)
PRODUCER_SPEC.loader.exec_module(producer)


class NativeEvidenceTests(unittest.TestCase):
    def fixture(self, directory):
        native = (ROOT / 'deploy/install-native.sh').read_text(encoding='utf-8')
        version = re.search(r"^version='([^']+)'$", native, re.M).group(1)
        for name in verifier.NATIVE_INSTALLERS:
            (directory / name).write_bytes((ROOT / 'deploy' / name).read_bytes())
        archive = directory / f'vectory-{version}-server-native-linux-amd64.tar.gz'
        archive.write_bytes(b'synthetic archive fixture; no executable bytes\n')
        proof = {'source_commit': 'f' * 40}
        evidence = {'passed': True, 'version': version, 'source_commit': proof['source_commit'],
                    'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                    'verified': sorted(verifier.NATIVE_CHECKS)}
        (directory / 'native-smoke.json').write_text(json.dumps(evidence), encoding='utf-8')
        (directory / 'vectory-native.spdx.json').write_text(json.dumps({
            'spdxVersion': 'SPDX-2.3', 'SPDXID': 'SPDXRef-DOCUMENT',
            'packages': [{'name': 'synthetic runtime package fixture'}]}), encoding='utf-8')
        return version, proof, evidence, archive

    def test_all_four_actual_source_installers_pass_complete_native_evidence_gate(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            version, proof, _, _ = self.fixture(directory)
            verifier.required_native_evidence(directory, version, proof)
            for name in verifier.NATIVE_INSTALLERS:
                self.assertEqual((directory / name).read_bytes(), (ROOT / 'deploy' / name).read_bytes())

    def test_prose_missing_wrong_and_bom_shell_headers_are_refused(self):
        for heading in (b'Authenticate prebuilt release bytes', b'#!/bin/sh', b'',
                        b'version="synthetic"', b'\xef\xbb\xbf#!/usr/bin/env bash'):
            with self.subTest(heading=heading), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                version, proof, _, _ = self.fixture(directory)
                (directory / 'install-native.sh').write_bytes(heading + b'\n' + f"version='{version}'\n".encode())
                with self.assertRaises(ValueError):
                    verifier.required_native_evidence(directory, version, proof)

    def test_native_body_requires_valid_utf8_and_existing_size_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            version, proof, _, _ = self.fixture(directory)
            script = directory / 'install-native.sh'
            original = script.read_bytes()
            script.write_bytes(original + b'\n#' + b'x' * 16384 + b'\xff\n')
            with self.assertRaises(UnicodeError):
                verifier.required_native_evidence(directory, version, proof)
            script.write_bytes(b'')
            with self.assertRaises(ValueError):
                verifier.required_native_evidence(directory, version, proof)
            script.write_bytes(original + b'x' * (verifier.MAX_TEXT_BYTES + 1 - len(original)))
            with self.assertRaises(ValueError):
                verifier.required_native_evidence(directory, version, proof)

    def test_native_missing_or_wrong_version_is_refused(self):
        for replacement in ('', "version='0.0.0-rejected-fixture'"):
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                version, proof, _, _ = self.fixture(directory)
                script = directory / 'install-native.sh'
                script.write_text(script.read_text(encoding='utf-8').replace(f"version='{version}'", replacement), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Public native installer version differs'):
                    verifier.required_native_evidence(directory, version, proof)

    def test_every_actual_docker_installer_wrong_version_is_refused(self):
        for name in verifier.NATIVE_INSTALLERS - {'install-native.sh'}:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                version, proof, _, _ = self.fixture(directory)
                script = directory / name
                text = script.read_text(encoding='utf-8-sig')
                pattern = (r"(\$version\s*=\s*)'" if name.endswith('.ps1') else r"(version=)'") + re.escape(version) + "'"
                text, changes = re.subn(pattern, r"\g<1>'0.0.0-rejected-fixture'", text)
                self.assertGreater(changes, 0)
                script.write_text(text, encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Public Docker installer version differs'):
                    verifier.required_native_evidence(directory, version, proof)

    def test_failed_missing_checks_wrong_source_version_and_archive_hash_are_refused(self):
        changes = ({'passed': False}, {'version': '0.0.0-rejected-fixture'}, {'source_commit': 'e' * 40},
                   {'archive_sha256': '0' * 64}, {'verified': []},
                   {'verified': sorted(verifier.NATIVE_CHECKS - {'stop'})},
                   {'verified': sorted(verifier.NATIVE_CHECKS | {'unsupported_fixture_check'})})
        for change in changes:
            with self.subTest(fields=sorted(change)), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                version, proof, evidence, _ = self.fixture(directory)
                evidence.update(change)
                (directory / 'native-smoke.json').write_text(json.dumps(evidence), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Native candidate lacks complete successful runtime'):
                    verifier.required_native_evidence(directory, version, proof)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            version, proof, _, archive = self.fixture(directory)
            archive.write_bytes(b'changed rejected synthetic archive bytes')
            with self.assertRaisesRegex(ValueError, 'Native candidate lacks complete successful runtime'):
                verifier.required_native_evidence(directory, version, proof)

    def test_unusable_native_sbom_is_refused(self):
        for document in ({}, {'spdxVersion': 'SPDX-2.3', 'SPDXID': 'SPDXRef-DOCUMENT', 'packages': []},
                         {'spdxVersion': 'wrong-fixture-format', 'SPDXID': 'SPDXRef-DOCUMENT',
                          'packages': [{'name': 'synthetic fixture'}]}):
            with self.subTest(document=document), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                version, proof, _, _ = self.fixture(directory)
                (directory / 'vectory-native.spdx.json').write_text(json.dumps(document), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'has no usable SBOM'):
                    verifier.required_native_evidence(directory, version, proof)


class NativeCandidatePartsTests(unittest.TestCase):
    """Synthetic contract checks stub heavy archives, preserving real parts gates."""
    def fixture(self, directory):
        version, proof, _, _ = NativeEvidenceTests().fixture(directory)
        agent_names = {'synthetic-agent-fixture'}
        catalog = [{'name': 'synthetic-agent-fixture', 'sha256': '0' * 64}]
        core, separator, prerelease = version.partition('-')
        deb_version = core + ('~' + prerelease if separator else '')
        rpm_version = core + ('~' + prerelease.replace('-', '_') if separator else '')
        names = verifier.REQUIRED_CANDIDATE_FILES | agent_names | verifier.NATIVE_FILES | {
            f'vectory_{deb_version}_amd64.deb', f'vectory_{deb_version}_arm64.deb',
            f'vectory-{rpm_version}-1.x86_64.rpm', f'vectory-{rpm_version}-1.aarch64.rpm',
            f'vectory-{version}-windows-amd64.msi', f'vectory-{version}-local-linux-amd64.tar.gz',
            f'vectory-{version}-server-linux-amd64.tar.gz', f'vectory-{version}-server-native-linux-amd64.tar.gz',
            f'vectory-{version}-native-runtime-source.tar.gz'}
        for name in names:
            path = directory / name
            if not path.exists():
                path.write_bytes(b'synthetic heavy archive contract fixture\n')
        for name in ('catalog.json', 'image-agent-catalog.json'):
            (directory / name).write_text(json.dumps(catalog), encoding='utf-8')
        return version, proof, agent_names, catalog

    def guard_context(self, version, proof, agent_names, catalog):
        context = ExitStack()
        # Only heavyweight binary/archive validation is replaced in these unit
        # fixtures. Installer evidence, manifest generation, completeness and
        # exact ordered parts equality all execute their production functions.
        context.enter_context(mock.patch.object(verifier, 'agent_inventory', return_value=(version, agent_names, catalog)))
        context.enter_context(mock.patch.object(verifier, 'non_agent_contents'))
        context.enter_context(mock.patch.object(verifier, 'required_native_bundle', return_value=proof))
        context.enter_context(mock.patch.object(verifier, 'required_native_sources'))
        context.enter_context(mock.patch.object(producer.runpy, 'run_path', return_value={
            'agent_inventory': verifier.agent_inventory, 'has_native_server': verifier.has_native_server,
            'candidate_inventory': verifier.candidate_inventory}))
        environment = {'GITHUB_SHA': proof['source_commit'], 'GITHUB_REF': 'refs/heads/synthetic-contract-fixture',
                       **{name: 'success' for name in producer.RESULTS.values()}, 'NATIVE_SERVER_RESULT': 'success'}
        context.enter_context(mock.patch.dict(producer.os.environ, environment, clear=True))
        context.enter_context(redirect_stdout(io.StringIO()))
        return context

    def test_actual_producer_and_reader_agree_on_canonical_native_source_parts(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            version, proof, agents, catalog = self.fixture(directory)
            with self.guard_context(version, proof, agents, catalog), mock.patch.object(
                    sys, 'argv', ['candidate-manifest.py', str(directory)]):
                producer.main()
                manifest = json.loads((directory / 'CANDIDATE.json').read_bytes())
                self.assertEqual(manifest['inventory_status'], 'complete')
                self.assertEqual(manifest['parts']['native_source'],
                                 ['native-runtime-source.json', f'vectory-{version}-native-runtime-source.tar.gz'])
                verifier.candidate_inventory(directory)

    def test_reordered_extra_and_missing_native_source_parts_remain_refused(self):
        for attack in ('reordered', 'extra', 'missing'):
            with self.subTest(attack=attack), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                version, proof, agents, catalog = self.fixture(directory)
                with self.guard_context(version, proof, agents, catalog), mock.patch.object(
                        sys, 'argv', ['candidate-manifest.py', str(directory)]):
                    producer.main()
                    path = directory / 'CANDIDATE.json'
                    manifest = json.loads(path.read_bytes())
                    self.assertEqual(manifest['inventory_status'], 'complete')
                    sources = manifest['parts']['native_source']
                    if attack == 'reordered':
                        sources.reverse()
                    elif attack == 'extra':
                        sources.append('unlisted-synthetic-source-fixture')
                    else:
                        sources.pop()
                    path.write_text(json.dumps(manifest), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, 'candidate manifest parts do not match'):
                        verifier.candidate_inventory(directory)


if __name__ == '__main__':
    unittest.main()
