"""Offline verifier regressions with synthetic archive bytes, never real installs."""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import tarfile
import unittest
from unittest import mock
import warnings
import zipfile

spec = importlib.util.spec_from_file_location("verify_release", Path(__file__).with_name("verify-release.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
image_spec = importlib.util.spec_from_file_location("check_image_agents", Path(__file__).with_name("check-image-agents.py"))
image_agents = importlib.util.module_from_spec(image_spec)
image_spec.loader.exec_module(image_agents)


class ArchiveVerification(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.name = "vectory-0.1.0-dev-windows-amd64.exe"
        self.binary = b"synthetic byte identity fixture, not executable"
        (self.root / self.name).write_bytes(self.binary)
        self.members = {
            "vectory.exe": self.binary,
            "LICENSE": b"license",
            "NOTICE": b"notice",
            "docs/AGENT-INSTALL.md": b"instructions",
            "docs/COMPATIBILITY.md": b"limitations",
            "RELEASE-STATUS.txt": b"UNSIGNED DEVELOPMENT BUILD",
            "packaging/windows/install-service.ps1": b"service template",
        }
        (self.root / "catalog.json").write_text(json.dumps([{
            "name": self.name, "os": "windows", "arch": "amd64", "version": "0.1.0-dev",
            "sha256": hashlib.sha256(self.binary).hexdigest(), "size": len(self.binary),
            "url": "/api/v1/releases/" + self.name, "signed": False,
        }]), encoding="utf-8")

    def write_archive(self, extra=None, symlink=False):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.root / (self.name[:-4] + ".zip"), "w") as out:
                for name, value in self.members.items():
                    out.writestr(name, value)
                if extra:
                    if symlink:
                        info = zipfile.ZipInfo(extra)
                        info.create_system = 3
                        info.external_attr = 0o120777 << 16
                        out.writestr(info, "../outside")
                    else:
                        out.writestr(extra, self.binary if extra == "vectory.exe" else b"extra")
        self.checksums()

    def checksums(self):
        (self.root / "SHA256SUMS").write_text("".join(
            f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n"
            for p in sorted(self.root.iterdir()) if p.name != "SHA256SUMS"
        ), encoding="utf-8")

    def test_complete_archive_passes(self):
        self.write_archive()
        self.assertEqual(verifier.verify(self.root), 1)

    def test_nonbinary_zip_crc_failure_is_rejected_with_matching_outer_checksum(self):
        self.write_archive()
        archive = self.root / (self.name[:-4] + '.zip')
        original = archive.read_bytes()
        self.assertEqual(original.count(b'license'), 1)
        archive.write_bytes(original.replace(b'license', b'licensX', 1))
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'corrupt ZIP member'):
            verifier.verify(self.root)

    def test_zip_end_record_rejects_trailer_and_accepts_comment(self):
        self.write_archive()
        archive = self.root / (self.name[:-4] + '.zip')
        original = archive.read_bytes()
        archive.write_bytes(original + b'EXTRA_TRAILING_PAYLOAD')
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'beyond its end record'):
            verifier.verify(self.root)

        archive.write_bytes(original)
        with zipfile.ZipFile(archive, 'a') as out:
            out.comment = b'legitimate ZIP comment'
        self.checksums()
        self.assertEqual(verifier.verify(self.root), 1)

        with zipfile.ZipFile(archive, 'w', allowZip64=True) as out:
            for name, contents in self.members.items():
                with out.open(name, 'w', force_zip64=True) as member:
                    member.write(contents)
        self.checksums()
        self.assertEqual(verifier.verify(self.root), 1)

    def test_agent_binary_and_archive_have_size_limits(self):
        self.write_archive()
        with mock.patch.object(verifier, 'MAX_AGENT_BINARY_BYTES', len(self.binary) - 1):
            with self.assertRaisesRegex(ValueError, 'exceeds its offline verification size limit'):
                verifier.verify(self.root)
        archive = self.root / (self.name[:-4] + '.zip')
        with mock.patch.object(verifier, 'MAX_AGENT_ARCHIVE_BYTES', archive.stat().st_size - 1):
            with self.assertRaisesRegex(ValueError, 'exceeds its offline verification size limit'):
                verifier.verify(self.root)

    def test_catalog_and_checksum_inventory_have_size_limits(self):
        self.write_archive()
        with mock.patch.object(verifier, 'MAX_AGENT_CATALOG_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'exceeds its offline verification size limit'):
                verifier.verify(self.root)
        with mock.patch.object(verifier, 'MAX_AGENT_CHECKSUMS_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'exceeds its offline verification size limit'):
                verifier.verify(self.root)

    def test_oversized_zip_binary_is_rejected_before_extraction(self):
        self.members['vectory.exe'] = self.binary * 3
        self.write_archive()
        with mock.patch.object(verifier, 'MAX_AGENT_BINARY_BYTES', len(self.binary) + 1):
            with self.assertRaisesRegex(ValueError, 'archive binary exceeds size limit'):
                verifier.verify(self.root)

    def test_archive_reader_bounds_actual_bytes(self):
        with mock.patch.object(verifier, 'MAX_AGENT_BINARY_BYTES', len(self.binary) - 1):
            with self.assertRaisesRegex(ValueError, 'archive binary exceeds size limit'):
                verifier.archive_binary_sha(io.BytesIO(self.binary))

    def test_archive_expanded_content_is_bounded(self):
        self.write_archive()
        with mock.patch.object(verifier, 'MAX_AGENT_ARCHIVE_UNPACKED_BYTES', len(self.binary) + 1):
            with self.assertRaisesRegex(ValueError, 'archive expanded contents exceed size limit'):
                verifier.verify(self.root)
        self.write_tar()
        with mock.patch.object(verifier, 'MAX_AGENT_ARCHIVE_UNPACKED_BYTES', len(self.binary) + 1):
            with self.assertRaisesRegex(ValueError, 'archive expanded contents exceed size limit'):
                verifier.verify(self.root)

    def test_duplicate_binary_is_rejected(self):
        self.write_archive("vectory.exe")
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def test_traversal_member_is_rejected(self):
        self.write_archive("../outside.txt")
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def test_symlink_member_is_rejected(self):
        del self.members["LICENSE"]
        self.write_archive("LICENSE", symlink=True)
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def test_missing_service_material_is_rejected(self):
        del self.members["packaging/windows/install-service.ps1"]
        self.write_archive()
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def test_empty_catalog_is_rejected(self):
        self.write_archive()
        (self.root / "catalog.json").write_text("[]", encoding="utf-8")
        self.checksums()
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def write_tar(self, attack=None, binary_in_archive=None, pax_comment=None, pax_headers=None):
        catalog = json.loads((self.root / "catalog.json").read_text(encoding="utf-8"))
        item = catalog[0]
        item["name"] = "vectory-0.1.0-dev-darwin-arm64"
        item["os"], item["arch"] = "darwin", "arm64"
        item["url"] = "/api/v1/releases/" + item["name"]
        (self.root / item["name"]).write_bytes(self.binary)
        (self.root / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")
        members = {**self.members}
        members["vectory"] = members.pop("vectory.exe")
        if binary_in_archive is not None:
            members["vectory"] = binary_in_archive
        members["packaging/launchd/io.vectory.agent.plist"] = members.pop("packaging/windows/install-service.ps1")
        if attack == "link":
            del members["LICENSE"]
        with tarfile.open(self.root / (item["name"] + ".tar.gz"), "w:gz") as out:
            for name, value in members.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(value)
                if name == 'LICENSE':
                    if pax_comment is not None:
                        entry.pax_headers = {'comment': pax_comment}
                    elif pax_headers is not None:
                        entry.pax_headers = pax_headers
                out.addfile(entry, io.BytesIO(value))
            if attack:
                entry = tarfile.TarInfo({"link": "LICENSE", "duplicate": "vectory", "traversal": "../outside"}[attack])
                if attack == "link":
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = "../outside"
                    out.addfile(entry)
                else:
                    entry.size = len(self.binary)
                    out.addfile(entry, io.BytesIO(self.binary))
        self.checksums()

    def test_complete_tar_passes(self):
        self.write_tar()
        self.assertEqual(verifier.verify(self.root), 1)

    def test_oversized_tar_binary_is_rejected_before_extraction(self):
        self.write_tar(binary_in_archive=self.binary * 3)
        with mock.patch.object(verifier, 'MAX_AGENT_BINARY_BYTES', len(self.binary) + 1):
            with self.assertRaisesRegex(ValueError, 'archive binary exceeds size limit'):
                verifier.verify(self.root)

    def test_tar_rejects_missing_gzip_footer_and_end_marker(self):
        self.write_tar()
        archive = self.root / 'vectory-0.1.0-dev-darwin-arm64.tar.gz'
        original = archive.read_bytes()
        archive.write_bytes(original[:-8])
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'not an intact gzip-compressed tar'):
            verifier.verify(self.root)

        unpacked = gzip.decompress(original)
        with tarfile.open(fileobj=io.BytesIO(unpacked), mode='r|') as source:
            list(source)
            first_end_marker = source.fileobj.pos
        archive.write_bytes(gzip.compress(unpacked[:first_end_marker], mtime=0))
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'complete tar end marker'):
            verifier.verify(self.root)

    def test_agent_tar_rejects_hidden_oversized_pax_metadata(self):
        self.write_tar(pax_comment='x' * (verifier.MAX_TAR_METADATA_BYTES + 1))
        with self.assertRaisesRegex(ValueError, 'oversized extended metadata'):
            verifier.verify(self.root)

    def test_agent_tar_rejects_gnu_sparse_pax_metadata(self):
        self.write_tar(pax_headers={'GNU.sparse.major': '1', 'GNU.sparse.minor': '0'})
        with self.assertRaisesRegex(ValueError, 'unsupported sparse metadata'):
            verifier.verify(self.root)

    def test_tar_unsafe_members_are_rejected(self):
        for attack in ("link", "duplicate", "traversal"):
            with self.subTest(attack=attack):
                self.write_tar(attack)
                with self.assertRaises(ValueError):
                    verifier.verify(self.root)


class ImageAgentVerification(unittest.TestCase):
    """The image job must hash the embedded bytes, not just compare catalogs."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog = []
        for os_name, arch in sorted(image_agents.TARGETS):
            name = f'vectory-0.1.0-{os_name}-{arch}' + ('.exe' if os_name == 'windows' else '')
            data = f'embedded {os_name}/{arch}'.encode()
            (self.root / name).write_bytes(data)
            self.catalog.append({
                'name': name, 'os': os_name, 'arch': arch, 'version': '0.1.0',
                'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data),
                'url': '/api/v1/releases/' + name, 'signed': False,
            })
        (self.root / 'catalog.json').write_text(json.dumps(self.catalog), encoding='utf-8')
        (self.root / 'SHA256SUMS').write_text('synthetic checksum fixture\n', encoding='utf-8')

    def test_embedded_bytes_match_the_image_catalog(self):
        self.assertEqual(image_agents.check(self.root), 5)

    def test_stale_embedded_binary_fails_even_when_catalogs_match(self):
        binary = self.root / self.catalog[0]['name']
        binary.write_bytes(b'changed binary bytes')
        with self.assertRaisesRegex(ValueError, 'bytes differ from catalog'):
            image_agents.check(self.root)

    def test_missing_or_extra_image_members_fail(self):
        binary = self.root / self.catalog[0]['name']
        original = binary.read_bytes()
        binary.unlink()
        with self.assertRaisesRegex(ValueError, 'bytes differ from catalog'):
            image_agents.check(self.root)
        binary.write_bytes(original)
        (self.root / 'unexpected').write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError, 'unexpected entries'):
            image_agents.check(self.root)


class CandidateVerification(unittest.TestCase):
    """Small synthetic files prove inventory checks, not native compatibility."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.version = '0.1.0'
        self.catalog = []
        for os_name, arch in sorted(verifier.TARGETS):
            base = f'vectory-{self.version}-{os_name}-{arch}'
            binary_name = base + ('.exe' if os_name == 'windows' else '')
            binary = self.linux_elf() if os_name == 'linux' else f'synthetic {base}'.encode()
            (self.root / binary_name).write_bytes(binary)
            self.catalog.append({
                'name': binary_name, 'os': os_name, 'arch': arch,
                'version': self.version, 'sha256': hashlib.sha256(binary).hexdigest(),
                'size': len(binary), 'url': '/api/v1/releases/' + binary_name,
                'signed': False,
            })
            service = {
                'linux': 'packaging/systemd/vectory.service',
                'darwin': 'packaging/launchd/io.vectory.agent.plist',
                'windows': 'packaging/windows/install-service.ps1',
            }[os_name]
            members = {
                'vectory.exe' if os_name == 'windows' else 'vectory': binary,
                'LICENSE': self.non_agent_bytes('LICENSE'),
                'NOTICE': self.non_agent_bytes('NOTICE'),
                'docs/AGENT-INSTALL.md': b'install',
                'docs/COMPATIBILITY.md': b'compatibility',
                'RELEASE-STATUS.txt': b'UNSIGNED DEVELOPMENT BUILD',
                service: b'service definition',
            }
            if os_name == 'windows':
                with zipfile.ZipFile(self.root / (base + '.zip'), 'w') as out:
                    for name, data in members.items():
                        out.writestr(name, data)
            else:
                with tarfile.open(self.root / (base + '.tar.gz'), 'w:gz') as out:
                    for name, data in members.items():
                        entry = tarfile.TarInfo(name)
                        entry.size = len(data)
                        out.addfile(entry, io.BytesIO(data))
        (self.root / 'catalog.json').write_text(json.dumps(self.catalog), encoding='utf-8')
        (self.root / 'image-agent-catalog.json').write_text(json.dumps(self.catalog), encoding='utf-8')
        self.packages = {
            'vectory_0.1.0_amd64.deb', 'vectory_0.1.0_arm64.deb',
            'vectory-0.1.0-1.x86_64.rpm', 'vectory-0.1.0-1.aarch64.rpm',
        }
        self.msi = f'vectory-{self.version}-windows-amd64.msi'
        self.preview = f'vectory-{self.version}-preview-linux-amd64.tar.gz'
        self.serverkit = f'vectory-{self.version}-server-linux-amd64.tar.gz'
        for name in (verifier.REQUIRED_CANDIDATE_FILES - {'catalog.json', 'CANDIDATE.json', 'SHA256SUMS', 'image-agent-catalog.json'}) | self.packages | {self.msi, self.preview, self.serverkit}:
            (self.root / name).write_bytes(self.non_agent_bytes(name))
        self.checksums()

    @staticmethod
    def source_fixture():
        prefix = 'pagefind-1.5.2-source/'
        inputs = [{'name': f'dependency-{index:02d}', 'version': '1.0.0',
                   'url': f'https://example.invalid/dependency-{index:02d}.crate',
                   'sha256': hashlib.sha256(str(index).encode()).hexdigest(),
                   'path': f'vendor/dependency-{index:02d}'}
                  for index in range(20)]
        inputs.extend([
            {'name': 'pagefind_microjson', 'version': '0.1.4',
             'url': 'https://example.invalid/pagefind_microjson.crate', 'sha256': 'a' * 64,
             'path': 'vendor/pagefind_microjson-0.1.4'},
            {'name': 'pagefind_web', 'version': '0.0.0',
             'url': f'https://github.com/CloudCannon/pagefind/archive/{verifier.PAGEFIND_COMMIT}.tar.gz',
             'sha256': 'b' * 64, 'upstream_commit': verifier.PAGEFIND_COMMIT,
             'path': 'upstream/pagefind_web'},
            {'name': 'Snowball', 'version': '3.0.0',
             'url': f'https://codeload.github.com/snowballstem/snowball/tar.gz/{verifier.SNOWBALL_COMMIT}',
             'sha256': verifier.SNOWBALL_SHA256, 'upstream_commit': verifier.SNOWBALL_COMMIT,
             'path': 'snowball'},
        ])
        members = {prefix + 'REBUILD.md': b'# Synthetic rebuild recipe\n'}
        members.update({prefix + item['path'] + '/Cargo.toml':
                        f'[package]\nname = "{item["name"]}"\n'.encode()
                        for item in inputs if item['name'] != 'Snowball'})
        members[prefix + 'snowball/algorithms/english.sbl'] = b'/* Synthetic algorithm */\n'
        members[prefix + 'snowball/COPYING'] = b'Synthetic source license\n'
        ui_inputs = []
        ui_locked = {}
        for name, version in verifier.PAGEFIND_UI_INPUTS.items():
            url = f'https://registry.npmjs.org/{name}/-/{name}-{version}.tgz'
            integrity = 'sha512-' + base64.b64encode(hashlib.sha512(name.encode()).digest()).decode()
            path = f'ui-vendor/{name}-{version}'
            ui_inputs.append({'name': name, 'version': version, 'url': url,
                              'sha256': hashlib.sha256(name.encode()).hexdigest(),
                              'integrity': integrity, 'path': path})
            ui_locked['node_modules/' + name] = {'version': version, 'resolved': url,
                                                 'integrity': integrity}
            members[prefix + path + '/package.json'] = json.dumps({'name': name, 'version': version}).encode()
        members[prefix + 'upstream/pagefind_ui/default/package-lock.json'] = json.dumps({'packages': ui_locked}).encode()
        file_entry = lambda name, data: {'path': name, 'sha256': hashlib.sha256(data).hexdigest(),
                                         'bytes': len(data)}
        internal_files = [file_entry(name, data) for name, data in sorted(members.items())]
        internal = {'schema': 1, 'upstream_commit': verifier.PAGEFIND_COMMIT,
                    'source_inputs': inputs, 'ui_source_inputs': ui_inputs, 'files': internal_files}
        members[prefix + 'SOURCE-MANIFEST.json'] = json.dumps(internal).encode()
        files = [file_entry(name, data) for name, data in sorted(members.items())]
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for name, data in sorted(members.items()):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        bundle = gzip.compress(stream.getvalue(), mtime=0)
        manifest = {
            'schema': 1,
            'component': 'Pagefind offline Help search',
            'version': '1.5.2',
            'upstream_commit': verifier.PAGEFIND_COMMIT,
            'upstream_source_url': f'https://github.com/CloudCannon/pagefind/archive/{verifier.PAGEFIND_COMMIT}.tar.gz',
            'archive': {'filename': 'pagefind-1.5.2-source.tar.gz',
                        'sha256': hashlib.sha256(bundle).hexdigest(), 'bytes': len(bundle)},
            'wasm': [{'filename': key, 'sha256': digest, 'bytes': verifier.PAGEFIND_WASM_BYTES[key]}
                     for key, digest in verifier.PAGEFIND_WASM_SHA256.items()],
            'build_recipe': prefix + 'REBUILD.md',
            'source_inputs': inputs,
            'ui_source_inputs': ui_inputs,
            'files': files,
        }
        return bundle, json.dumps(manifest).encode()

    @staticmethod
    def non_agent_bytes(name):
        if name.endswith('.deb'):
            header = (f'{"debian-binary/":<16}{"0":<12}{"0":<6}{"0":<6}'
                      f'{"100644":<8}{"4":<10}`\n').encode()
            assert len(header) == 60
            return b'!<arch>\n' + header + b'2.0\n'
        if name.endswith('.rpm'):
            return b'\xed\xab\xee\xdb' + bytes(92) + b'\x8e\xad\xe8\x01' + bytes(12)
        if name.endswith('.msi'):
            return b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + bytes(504)
        if name.endswith(('-preview-linux-amd64.tar.gz', '-server-linux-amd64.tar.gz')):
            stream = io.BytesIO()
            prefix = name.removesuffix('.tar.gz') + '/'
            kind = 'preview' if name.endswith('-preview-linux-amd64.tar.gz') else 'server'
            files = {
                'compose.yaml': b'services:\n  server:\n    image: vectory-server:candidate\n',
                'README.md': f'# Vectory {kind} kit\n\nSynthetic fixture.\n'.encode(),
                'LICENSE': CandidateVerification.non_agent_bytes('LICENSE'),
                'NOTICE': CandidateVerification.non_agent_bytes('NOTICE'),
                'VERSION': b'0.1.0\n',
            }
            if kind == 'preview':
                files['start.sh'] = b'#!/bin/sh\nexit 0\n'
            else:
                files['Caddyfile'] = b':443 { reverse_proxy server:8080 }\n'
                files['.env.example'] = b'VECTORY_HOSTNAME=example.invalid\n'
                files['start.sh'] = b'#!/bin/sh\nexit 0\n'
            files['release-images.sh'] = b'#!/bin/sh\n# Shared image loader fixture.\n'
            files['SHA256SUMS'] = ''.join(
                f'{hashlib.sha256(files[part]).hexdigest()}  {part}\n'
                for part in sorted(files)
            ).encode()
            with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                for part, content in files.items():
                    member = tarfile.TarInfo(prefix + part)
                    member.mode = 0o755 if part == 'start.sh' else 0o644
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
            return stream.getvalue()
        if name.endswith('-image.tar.gz'):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                tag = name.removesuffix('-image.tar.gz') + ':candidate'
                files = {
                    'manifest.json': json.dumps([{
                        'Config': 'config.json', 'RepoTags': [tag],
                        'Layers': ['layer/layer.tar'],
                    }]).encode(),
                    'config.json': b'{"architecture":"amd64","os":"linux"}',
                    'layer/layer.tar': b'synthetic layer bytes',
                }
                for member_name, content in files.items():
                    member = tarfile.TarInfo(member_name)
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
            return stream.getvalue()
        if name.endswith('.cdx.json'):
            return json.dumps({'bomFormat': 'CycloneDX', 'specVersion': '1.5',
                               'components': [{'name': 'synthetic-component'}]}).encode()
        if name.endswith('.spdx.json'):
            return json.dumps({'spdxVersion': 'SPDX-2.3', 'SPDXID': 'SPDXRef-DOCUMENT',
                               'packages': [{'name': 'synthetic-component'}]}).encode()
        if name == 'pagefind-1.5.2-source.tar.gz':
            return CandidateVerification.source_fixture()[0]
        if name == 'pagefind-1.5.2-source.json':
            return CandidateVerification.source_fixture()[1]
        if name == 'license-inventory.json':
            return json.dumps({'components': [{'name': 'synthetic-component'}]}).encode()
        if name == 'SOURCE-INPUTS.json':
            return json.dumps({'signed': False, 'canonical_file_inventory_sha256': 'a' * 64,
                               'files': [{'path': 'synthetic'}]}).encode()
        if name == 'npm-dependency-audit.json':
            return json.dumps({'gate_passed': True, 'raw_audit': {
                'dashboard': {}, 'help-center': {}}}).encode()
        if name == 'images.json':
            return json.dumps([{'RepoTags': ['vectory-server:candidate']},
                               {'RepoTags': ['vectory-validator:candidate']}]).encode()
        if name == 'THIRD-PARTY-LICENSES.md':
            return b'# Third-party licenses\n\nSynthetic fixture.\n'
        if name == 'LICENSE':
            return b'Apache License\n\nSynthetic fixture.\n'
        if name == 'NOTICE':
            return b'Vectory\n\nSynthetic third-party notices.\n'
        if name == 'THIRD-PARTY-INVENTORY.md':
            return b'# Source dependency inventory\n\nSynthetic fixture.\n'
        return f'synthetic {name}\n'.encode()

    @staticmethod
    def linux_elf():
        # Enough of an ELF header for the static-structure verifier to inspect.
        binary = bytearray(64)
        binary[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<Q', binary, 32, 64)
        struct.pack_into('<HH', binary, 54, 56, 0)
        return bytes(binary)

    def manifest(self, failed_job=None):
        env = os.environ.copy()
        for job, variable in [('packages', 'PACKAGES_RESULT'), ('msi', 'MSI_RESULT'),
                              ('images', 'IMAGES_RESULT'), ('sbom', 'SBOM_RESULT'),
                              ('starters', 'STARTERS_RESULT'),
                              ('preview_smoke', 'PREVIEW_SMOKE_RESULT')]:
            env[variable] = 'failure' if job == failed_job else 'success'
        subprocess.run([sys.executable, str(Path(__file__).with_name('candidate-manifest.py')),
                        str(self.root)], env=env, check=True, capture_output=True, text=True)
        self.checksums()
        return json.loads((self.root / 'CANDIDATE.json').read_text(encoding='utf-8'))

    def checksums(self):
        (self.root / 'SHA256SUMS').write_text(''.join(
            f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
            for path in sorted(self.root.iterdir()) if path.name != 'SHA256SUMS'
        ), encoding='utf-8')

    def rewrite_preview(self, replace=None, extra=None, symlink=None, mode_change=None):
        """Mutate only the nested starter, then refresh outer candidate hashes."""
        path = self.root / self.preview
        records = []
        with tarfile.open(path, 'r:gz') as source:
            for member in source:
                records.append((member.name, member.mode, source.extractfile(member).read()))
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            for name, mode, data in records:
                member = tarfile.TarInfo(name)
                member.mode = mode
                if mode_change and name.endswith('/' + mode_change[0]):
                    member.mode = mode_change[1]
                if name.endswith('/' + (symlink or '')) and symlink:
                    member.type = tarfile.SYMTYPE
                    member.linkname = '../outside'
                    member.size = 0
                    archive.addfile(member)
                    continue
                if replace and name.endswith('/' + replace[0]):
                    data = replace[1]
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                member = tarfile.TarInfo(self.preview.removesuffix('.tar.gz') + '/' + extra)
                member.mode = 0o644
                member.size = 5
                archive.addfile(member, io.BytesIO(b'large'))
        path.write_bytes(stream.getvalue())
        self.checksums()

    def test_complete_candidate_passes_strict_offline_verification(self):
        manifest = self.manifest()
        self.assertEqual(manifest['inventory_status'], 'complete')
        self.assertEqual(manifest['parts']['preview'], [self.preview])
        self.assertEqual(manifest['parts']['serverkit'], [self.serverkit])
        self.assertEqual(manifest['parts']['legal'], ['LICENSE', 'NOTICE'])
        self.assertEqual(manifest['parts']['source'],
                         ['pagefind-1.5.2-source.json', 'pagefind-1.5.2-source.tar.gz'])
        self.assertEqual(len(manifest['parts']['agents']), 10)
        self.assertNotIn(self.preview, manifest['parts']['agents'])
        self.assertNotIn(self.serverkit, manifest['parts']['agents'])
        self.assertEqual(verifier.verify_candidate(self.root), 5)
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('verify-release.py')),
                                 str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_plain_notice_must_match_agent_and_starter_archives(self):
        notice = self.root / 'NOTICE'
        notice.write_bytes(b'Vectory\n\nDifferent notice bytes.\n')
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'archive LICENSE or NOTICE differs'):
            verifier.verify(self.root)
        self.assertEqual(self.manifest()['inventory_status'], 'incomplete-diagnostic')
        with self.assertRaisesRegex(ValueError, 'NOTICE differs from the release asset'):
            verifier.candidate_inventory(self.root, require_status=False)

    def test_pagefind_source_requires_pinned_wasm_and_real_file_hashes(self):
        path = self.root / 'pagefind-1.5.2-source.json'
        original = path.read_bytes()
        for change, message in [('wasm', 'shipped Help WASM pins'),
                                ('file', 'source archive member differs'),
                                ('ui-version', 'five pinned UI source packages'),
                                ('ui-package-file', 'omits a rebuild recipe or pinned dependency')]:
            with self.subTest(change=change):
                manifest = json.loads(original)
                if change == 'wasm':
                    manifest['wasm'][0]['sha256'] = '0' * 64
                elif change == 'file':
                    manifest['files'][0]['sha256'] = '0' * 64
                elif change == 'ui-version':
                    manifest['ui_source_inputs'][0]['version'] = '0.0.0'
                else:
                    required_name = 'pagefind-1.5.2-source/ui-vendor/svelte-4.2.20/package.json'
                    manifest['files'] = [item for item in manifest['files']
                                         if item['path'] != required_name]
                path.write_text(json.dumps(manifest), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, message):
                    verifier.required_pagefind_source(self.root)
        path.write_bytes(original)

    def test_missing_release_parts_are_diagnostic_and_refused(self):
        for name in [
            'vectory_0.1.0_arm64.deb', self.msi,
            self.preview,
            self.serverkit,
            'vectory-server-image.tar.gz', 'vectory-validator-image.spdx.json',
            'NOTICE',
            'pagefind-1.5.2-source.tar.gz',
            'vectory-agent.cdx.json', 'license-inventory.json',
            'npm-dependency-audit.json', 'THIRD-PARTY-INVENTORY.md',
        ]:
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                path.unlink()
                manifest = self.manifest()
                self.assertEqual(manifest['inventory_status'], 'incomplete-diagnostic')
                self.assertIn('Do not publish', manifest['note'])
                with self.assertRaises(ValueError):
                    verifier.verify_candidate(self.root)
                path.write_bytes(original)

    def test_failed_job_is_refused_even_with_every_file(self):
        manifest = self.manifest(failed_job='images')
        self.assertEqual(manifest['inventory_status'], 'incomplete-diagnostic')
        with self.assertRaisesRegex(ValueError, 'marked incomplete'):
            verifier.verify_candidate(self.root)

    def test_partial_artifact_can_be_assembled_but_not_verified_for_release(self):
        (self.root / 'vectory-validator-image.tar.gz').unlink()
        self.assertEqual(self.manifest(failed_job='images')['inventory_status'],
                         'incomplete-diagnostic')
        script = str(Path(__file__).with_name('verify-release.py'))
        refresh = subprocess.run([sys.executable, script, str(self.root),
                                  '--refresh-checksums'], capture_output=True, text=True)
        self.assertEqual(refresh.returncode, 0, refresh.stderr)
        self.assertIn('completeness has not been verified', refresh.stdout)
        final = subprocess.run([sys.executable, script, str(self.root)],
                               capture_output=True, text=True)
        self.assertNotEqual(final.returncode, 0)

    def test_mismatched_image_agents_and_extra_file_are_refused(self):
        image_catalog = self.root / 'image-agent-catalog.json'
        bundled = json.loads(image_catalog.read_text(encoding='utf-8'))
        bundled[0]['sha256'] = '0' * 64
        image_catalog.write_text(json.dumps(bundled), encoding='utf-8')
        self.assertEqual(self.manifest()['inventory_status'], 'incomplete-diagnostic')
        with self.assertRaises(ValueError):
            verifier.verify_candidate(self.root)
        image_catalog.write_text(json.dumps(self.catalog), encoding='utf-8')
        (self.root / 'unexpected.txt').write_text('extra', encoding='utf-8')
        self.assertEqual(self.manifest()['inventory_status'], 'incomplete-diagnostic')
        with self.assertRaises(ValueError):
            verifier.verify_candidate(self.root)

    def test_package_for_another_version_is_refused(self):
        (self.root / 'vectory_0.1.0_arm64.deb').rename(
            self.root / 'vectory_9.9.9_arm64.deb')
        self.assertEqual(self.manifest()['inventory_status'], 'incomplete-diagnostic')
        with self.assertRaises(ValueError):
            verifier.verify_candidate(self.root)

    def test_preview_rejects_modified_member_and_embedded_images(self):
        self.assertEqual(self.manifest()['inventory_status'], 'complete')
        self.rewrite_preview(replace=('README.md', b'# Altered preview\n'))
        with self.assertRaisesRegex(ValueError, 'preview checksum mismatch: README'):
            verifier.candidate_inventory(self.root, require_status=False)
        self.assertEqual(self.manifest()['inventory_status'], 'incomplete-diagnostic')

        (self.root / self.preview).write_bytes(self.non_agent_bytes(self.preview))
        self.rewrite_preview(extra='vectory-server-image.tar.gz')
        with self.assertRaisesRegex(ValueError, 'unexpected preview member'):
            verifier.candidate_inventory(self.root, require_status=False)

    def test_preview_rejects_a_linked_starter(self):
        self.assertEqual(self.manifest()['inventory_status'], 'complete')
        self.rewrite_preview(symlink='start.sh')
        with self.assertRaisesRegex(ValueError, 'unexpected preview member'):
            verifier.candidate_inventory(self.root, require_status=False)

    def test_preview_rejects_nonexecutable_starter(self):
        self.assertEqual(self.manifest()['inventory_status'], 'complete')
        self.rewrite_preview(mode_change=('start.sh', 0o644))
        with self.assertRaisesRegex(ValueError, 'unsafe or unexpected preview member'):
            verifier.candidate_inventory(self.root, require_status=False)

    def test_preview_rejects_notice_above_its_separate_bound(self):
        self.rewrite_preview(replace=('NOTICE', b'x' * (verifier.MAX_PREVIEW_NOTICE_BYTES + 1)))
        with self.assertRaisesRegex(ValueError, 'unsafe or unexpected preview member'):
            verifier.required_starter_bundle(self.root / self.preview, self.version, 'preview')

    def test_empty_or_malformed_non_agent_deliverables_are_refused(self):
        self.assertEqual(self.manifest()['inventory_status'], 'complete')
        for name, bad in [
            ('vectory_0.1.0_amd64.deb', b'not an ar package'),
            ('vectory-0.1.0-1.x86_64.rpm', b'not an rpm package'),
            (self.msi, b'not an MSI'),
            (self.preview, b'not a preview gzip tar'),
            (self.serverkit, b'not a server gzip tar'),
            ('vectory-server-image.tar.gz', b'not a gzip tar'),
            ('vectory-agent.cdx.json', b''),
            ('vectory-dashboard.cdx.json', b'{}'),
            ('vectory-validator-image.spdx.json', b'{broken JSON'),
            ('license-inventory.json', b'{}'),
            ('SOURCE-INPUTS.json', b'{}'),
            ('npm-dependency-audit.json', b'{"gate_passed":false}'),
            ('images.json', b'[]'),
            ('THIRD-PARTY-LICENSES.md', b''),
            ('LICENSE', b'not the shipped license'),
            ('NOTICE', b'not the shipped notice'),
            ('pagefind-1.5.2-source.tar.gz', b'not a source archive'),
            ('pagefind-1.5.2-source.json', b'{}'),
            ('install.log', b''),
        ]:
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                path.write_bytes(bad)
                with self.assertRaisesRegex(ValueError, name.replace('.', r'\.')):
                    verifier.candidate_inventory(self.root, require_status=False)
                manifest = self.manifest()
                self.assertEqual(manifest['inventory_status'], 'incomplete-diagnostic')
                with self.assertRaises(ValueError):
                    verifier.verify_candidate(self.root)
                path.write_bytes(original)

    def test_malformed_image_catalog_still_produces_diagnostic_artifact(self):
        path = self.root / 'image-agent-catalog.json'
        path.write_bytes(b'{malformed JSON')
        manifest = self.manifest()
        self.assertEqual(manifest['inventory_status'], 'incomplete-diagnostic')
        self.assertEqual(manifest['image_agents_match_release_agents']['compared'], False)
        self.assertIn('catalog comparison unavailable',
                      manifest['image_agents_match_release_agents']['reason'])
        with self.assertRaises(ValueError):
            verifier.verify_candidate(self.root)

    def test_image_archives_require_complete_streams_and_referenced_layers(self):
        self.assertEqual(self.manifest()['inventory_status'], 'complete')
        path = self.root / 'vectory-server-image.tar.gz'
        original = path.read_bytes()
        padded = bytearray(gzip.decompress(original))
        padded[-1] = ord('x')
        with tarfile.open(fileobj=io.BytesIO(padded), mode='r|') as archive:
            list(archive)
            member_end = archive.offset
        for label, bad in [
            ('missing gzip footer', original[:-8]),
            ('missing layer', self.image_without_layer('vectory-server:candidate')),
            ('missing tar end marker', gzip.compress(padded[:member_end], mtime=0)),
            ('nonzero buffered tar padding', gzip.compress(padded, mtime=0)),
            ('nonzero tar tail', gzip.compress(gzip.decompress(original) + b'corrupt', mtime=0)),
        ]:
            with self.subTest(label=label):
                path.write_bytes(bad)
                with self.assertRaisesRegex(ValueError, path.name.replace('.', r'\.')):
                    verifier.candidate_inventory(self.root, require_status=False)
                self.assertEqual(self.manifest()['inventory_status'], 'incomplete-diagnostic')
        path.write_bytes(original)
        self.assertEqual(self.manifest()['inventory_status'], 'complete')
        with mock.patch.object(verifier, 'MAX_IMAGE_UNPACKED_BYTES', 1024):
            with self.assertRaisesRegex(ValueError, 'expanded image size limit'):
                verifier.required_image(path)

    def test_image_archive_accepts_directory_and_pax_metadata(self):
        path = self.root / 'vectory-server-image.tar.gz'
        long_layer = 'layers/' + 'a' * 120 + '/layer.tar'
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.PAX_FORMAT) as archive:
            directory = tarfile.TarInfo('layers/')
            directory.type = tarfile.DIRTYPE
            archive.addfile(directory)
            for name, contents in {
                'manifest.json': json.dumps([{
                    'Config': 'config.json', 'RepoTags': ['vectory-server:candidate'],
                    'Layers': [long_layer],
                }]).encode(),
                'config.json': b'{"architecture":"amd64","os":"linux"}',
                long_layer: b'synthetic layer bytes',
            }.items():
                member = tarfile.TarInfo(name)
                member.size = len(contents)
                archive.addfile(member, io.BytesIO(contents))
        path.write_bytes(stream.getvalue())
        verifier.required_image(path)

    def test_image_archive_rejects_hidden_oversized_pax_metadata(self):
        path = self.root / 'vectory-server-image.tar.gz'
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.PAX_FORMAT) as archive:
            for name, contents in {
                'manifest.json': json.dumps([{
                    'Config': 'config.json', 'RepoTags': ['vectory-server:candidate'],
                    'Layers': ['layer/layer.tar'],
                }]).encode(),
                'config.json': b'{"architecture":"amd64","os":"linux"}',
                'layer/layer.tar': b'synthetic layer bytes',
            }.items():
                member = tarfile.TarInfo(name)
                member.size = len(contents)
                if name == 'config.json':
                    member.pax_headers = {'comment': 'x' * (verifier.MAX_TAR_METADATA_BYTES + 1)}
                archive.addfile(member, io.BytesIO(contents))
        path.write_bytes(stream.getvalue())
        with self.assertRaisesRegex(ValueError, 'oversized extended metadata'):
            verifier.required_image(path)

    def test_image_archive_rejects_gnu_sparse_pax_map_before_parsing_body(self):
        path = self.root / 'vectory-server-image.tar.gz'
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.PAX_FORMAT) as archive:
            member = tarfile.TarInfo('manifest.json')
            member.pax_headers = {'GNU.sparse.major': '1', 'GNU.sparse.minor': '0'}
            payload = b'100000\n' + b'0\n1\n' * 10_000
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))
        path.write_bytes(stream.getvalue())
        with self.assertRaisesRegex(ValueError, 'unsupported sparse metadata'):
            verifier.required_image(path)

    def test_image_archive_rejects_hidden_oversized_gnu_longname(self):
        path = self.root / 'vectory-server-image.tar.gz'
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.GNU_FORMAT) as archive:
            member = tarfile.TarInfo('a' * 300)
            member.size = 1
            archive.addfile(member, io.BytesIO(b'x'))
        path.write_bytes(stream.getvalue())
        with mock.patch.object(verifier, 'MAX_TAR_METADATA_BYTES', 128):
            with self.assertRaisesRegex(ValueError, 'oversized extended metadata'):
                verifier.required_image(path)

    def test_image_archive_accepts_only_safe_referenced_layer_symlinks(self):
        path = self.root / 'vectory-server-image.tar.gz'
        path.write_bytes(self.image_with_layer_link('../first/layer.tar'))
        verifier.required_image(path)

        for label, linkname, referenced, error in [
            ('escape', '../../outside/layer.tar', True, 'escapes the archive'),
            ('missing target', '../missing/layer.tar', True, 'lacks a regular referenced Docker layer'),
            ('unreferenced', '../first/layer.tar', False, 'unreferenced layer symlink'),
        ]:
            with self.subTest(label=label):
                path.write_bytes(self.image_with_layer_link(linkname, referenced=referenced))
                with self.assertRaisesRegex(ValueError, error):
                    verifier.required_image(path)

    @staticmethod
    def image_with_layer_link(linkname, referenced=True):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            layers = ['first/layer.tar'] + (['second/layer.tar'] if referenced else [])
            for name, contents in {
                'manifest.json': json.dumps([{
                    'Config': 'config.json', 'RepoTags': ['vectory-server:candidate'],
                    'Layers': layers,
                }]).encode(),
                'config.json': b'{"architecture":"amd64","os":"linux"}',
                'first/layer.tar': b'synthetic layer bytes',
            }.items():
                member = tarfile.TarInfo(name)
                member.size = len(contents)
                archive.addfile(member, io.BytesIO(contents))
            link = tarfile.TarInfo('second/layer.tar')
            link.type = tarfile.SYMTYPE
            link.linkname = linkname
            archive.addfile(link)
        return stream.getvalue()

    def test_valid_gzip_with_truncated_tar_member_is_refused(self):
        path = self.root / 'vectory-server-image.tar.gz'
        member = tarfile.TarInfo('manifest.json')
        member.size = 2048
        path.write_bytes(gzip.compress(member.tobuf() + b'{}', mtime=0))
        with self.assertRaisesRegex(ValueError, 'intact gzip-compressed tar'):
            verifier.required_image(path)

    def test_image_archive_rejects_oversized_pax_path(self):
        path = self.root / 'vectory-server-image.tar.gz'
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.PAX_FORMAT) as archive:
            member = tarfile.TarInfo('a' * (verifier.MAX_IMAGE_PATH_BYTES + 1))
            member.size = 1
            archive.addfile(member, io.BytesIO(b'x'))
        path.write_bytes(stream.getvalue())
        with self.assertRaisesRegex(ValueError, 'unsafe or duplicate image member'):
            verifier.required_image(path)

    @staticmethod
    def image_without_layer(tag):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            for name, content in {
                'manifest.json': json.dumps([{
                    'Config': 'config.json', 'RepoTags': [tag],
                    'Layers': ['missing/layer.tar'],
                }]).encode(),
                'config.json': b'{"architecture":"amd64","os":"linux"}',
            }.items():
                member = tarfile.TarInfo(name)
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        return stream.getvalue()


if __name__ == "__main__":
    unittest.main()
