#!/usr/bin/env python3
"""Verify actual catalog bytes, archive contents, and static Linux ELF structure."""
import argparse
import gzip
import hashlib
import json
import tarfile
import zipfile
from pathlib import Path, PurePosixPath
import re
import stat
import struct


# The release workflow builds these five targets. The catalog/archive verifier
# below also serves smaller development bundles, but a release candidate must
# contain every one of them and every other deliverable named here.
TARGETS = {('linux', 'amd64'), ('linux', 'arm64'), ('darwin', 'amd64'),
           ('darwin', 'arm64'), ('windows', 'amd64')}
REQUIRED_CANDIDATE_FILES = {
    'catalog.json', 'CANDIDATE.json', 'SHA256SUMS',
    'LICENSE', 'NOTICE',
    'pagefind-1.5.2-source.tar.gz', 'pagefind-1.5.2-source.json',
    'vectory-server-image.tar.gz', 'vectory-validator-image.tar.gz',
    'vectory-server-image.spdx.json', 'vectory-validator-image.spdx.json',
    'image-agent-catalog.json', 'images.json',
    'server-without-settings.log', 'validator-without-isolation.log',
    'vectory-server.cdx.json', 'vectory-agent.cdx.json',
    'vectory-dashboard.cdx.json', 'vectory-help-center.cdx.json',
    'THIRD-PARTY-LICENSES.md', 'license-inventory.json',
    'source.spdx.json', 'THIRD-PARTY-INVENTORY.md', 'SOURCE-INPUTS.json',
    'npm-dependency-audit.json', 'install.log', 'uninstall.log',
}
REQUIRED_JOBS = ('packages', 'msi', 'images', 'sbom', 'starters', 'preview_smoke')
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_TEXT_BYTES = 32 * 1024 * 1024
MAX_AGENT_CATALOG_BYTES = 1024 * 1024
MAX_AGENT_CHECKSUMS_BYTES = 1024 * 1024
MAX_AGENT_BINARY_BYTES = 256 * 1024 * 1024
MAX_AGENT_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_AGENT_ARCHIVE_UNPACKED_BYTES = 512 * 1024 * 1024
MAX_TAR_METADATA_BYTES = 1024 * 1024
MAX_TAR_METADATA_TOTAL_BYTES = 8 * 1024 * 1024
MAX_TAR_METADATA_RECORDS = 128
MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024 * 1024
MAX_IMAGE_UNPACKED_BYTES = 64 * 1024 * 1024 * 1024
MAX_IMAGE_MEMBERS = 10_000
MAX_IMAGE_MANIFEST_BYTES = 8 * 1024 * 1024
MAX_IMAGE_READ_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PATH_BYTES = 1024
MAX_PREVIEW_BUNDLE_BYTES = 4 * 1024 * 1024
MAX_PREVIEW_UNPACKED_BYTES = 8 * 1024 * 1024
MAX_PREVIEW_MEMBER_BYTES = 1024 * 1024
MAX_PREVIEW_NOTICE_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BUNDLE_BYTES = 128 * 1024 * 1024
MAX_SOURCE_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_SOURCE_MEMBER_BYTES = 128 * 1024 * 1024
MAX_SOURCE_MEMBERS = 10_000
MAX_SOURCE_METADATA_TOTAL_BYTES = 32 * 1024 * 1024
PAGEFIND_COMMIT = 'a2e9f40ef326f9a7926247695df25981a6f3ef4b'
SNOWBALL_COMMIT = '988b5ae3fff9db34cc978c8ddd3b84f83ef5ef58'
SNOWBALL_SHA256 = '571f314a0d86fefa0eaf5e2cd39a944a82f9d0ef314ce085f97f16154a354343'
PAGEFIND_PLATFORM_PINS = {
    'linux-x64': {
        'wasm.en.pagefind': ('bb16c9e6d3d214d4d05cccca51df7b487b86b3657318da767f6ca9e0a2e7259d', 72209,
                             'b79a9c0cde49a652854df3a09363fe2f088ccfe6bb6dc03c29b1a8b22f331415'),
        'wasm.unknown.pagefind': ('3a74cefceacd066e8d3bc8c52e7bc1c869544ca3d9031b44a9b7136356d5d7f4', 68024,
                                  '26fc70ed88bf7c04481a2d5c92ac353218c2bc5af56d79e318d3c22c70d5bd8f'),
    },
    'win32-x64': {
        'wasm.en.pagefind': ('68c6aefbc022a1482b1a9d2adbd5599f23fd53ac0326e58cb3aebd82e8cd8232', 72206,
                             '34f56598d5cb14f240bcf0564a196b54f879528c8f2202577d0885ca42be80b7'),
        'wasm.unknown.pagefind': ('706a7a423f3e9fdd1b6e987b61305a9abf694ca940b3f822e12f2668e4037384', 68023,
                                  'd7e2e8234ffd6540e5be62e7ae8ca1350d3c74b3d584d57116046306506eb486'),
    },
}
PAGEFIND_PROFILE_KEYS = {'darwin-arm64', 'darwin-x64', 'freebsd-x64', 'linux-arm64',
                         'linux-x64', 'win32-arm64', 'win32-x64'}
PAGEFIND_UI_INPUTS = {
    'svelte': '4.2.20',
    'bcp-47': '2.1.0',
    'is-alphabetical': '2.0.1',
    'is-alphanumerical': '2.0.1',
    'is-decimal': '2.0.1',
}
STARTER_FILES = {
    'preview': {'start.sh', 'release-images.sh', 'verify-release.sh', 'prepare-offline.sh', 'compose.yaml', 'README.md', 'LICENSE', 'NOTICE', 'VERSION', 'SHA256SUMS'},
    'server': {'start.sh', 'start-auto.sh', 'release-images.sh', 'verify-release.sh', 'prepare-offline.sh', 'compose.yaml', 'compose.auto.yaml', 'Caddyfile', 'Caddyfile.auto', '.env.example',
               'README.md', 'LICENSE', 'NOTICE', 'VERSION', 'SHA256SUMS'},
}


def sha(p):
    digest = hashlib.sha256()
    with p.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def archive_binary_sha(source):
    """Hash one already size-checked archive member without allocating it."""
    digest = hashlib.sha256()
    total = 0
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        total += len(chunk)
        if total > MAX_AGENT_BINARY_BYTES:
            raise ValueError('archive binary exceeds size limit')
        digest.update(chunk)
    return digest.hexdigest()


def required_zip_end(path):
    """Require the ZIP end record and its declared comment to reach EOF."""
    size = path.stat().st_size
    tail_size = min(size, 22 + 65535)
    with path.open('rb') as source:
        source.seek(size - tail_size)
        tail = source.read(tail_size)
    start = tail.rfind(b'PK\x05\x06')
    if (start < 0 or start + 22 > len(tail)
            or start + 22 + struct.unpack_from('<H', tail, start + 20)[0] != len(tail)):
        raise ValueError('archive ZIP has data beyond its end record and comment')


class BoundedAgentReader:
    """Count the expanded agent tar; draining it also checks the gzip footer."""

    def __init__(self, source):
        self.source = source
        self.total = 0

    def read(self, size):
        if size < 0 or size > 16 * 1024 * 1024:
            raise ValueError('agent archive requested an oversized read')
        chunk = self.source.read(size)
        self.total += len(chunk)
        if self.total > MAX_AGENT_ARCHIVE_UNPACKED_BYTES:
            raise ValueError('archive expanded contents exceed size limit')
        return chunk


class BoundedTarInfo(tarfile.TarInfo):
    """Refuse hidden tar metadata before tarfile buffers its full payload."""

    def _charge_extension(self, archive):
        count = getattr(archive, '_vectory_metadata_records', 0) + 1
        total = getattr(archive, '_vectory_metadata_bytes', 0) + self.size
        if (self.size < 0 or self.size > MAX_TAR_METADATA_BYTES
                or total > MAX_TAR_METADATA_TOTAL_BYTES
                or count > MAX_TAR_METADATA_RECORDS):
            raise ValueError('tar archive has oversized extended metadata')
        archive._vectory_metadata_records = count
        archive._vectory_metadata_bytes = total

    def _proc_pax(self, archive):
        self._charge_extension(archive)
        return super()._proc_pax(archive)

    def _proc_gnulong(self, archive):
        self._charge_extension(archive)
        return super()._proc_gnulong(archive)

    def _proc_sparse(self, archive):
        raise ValueError('tar archive contains unsupported sparse metadata')

    def _proc_gnusparse_00(self, member, headers, data):
        raise ValueError('tar archive contains unsupported sparse metadata')

    def _proc_gnusparse_01(self, member, headers):
        raise ValueError('tar archive contains unsupported sparse metadata')

    def _proc_gnusparse_10(self, member, headers, archive):
        # tarfile otherwise grows a list from a map embedded in the next
        # member body before yielding that member to our bounded reader.
        raise ValueError('tar archive contains unsupported sparse metadata')


def static_elf(path):
    data = path.read_bytes()
    if data[:6] != b'\x7fELF\x02\x01':
        raise ValueError('expected little-endian 64-bit ELF: ' + path.name)
    offset, = struct.unpack_from('<Q', data, 32)
    entry_size, entries = struct.unpack_from('<HH', data, 54)
    for index in range(entries):
        start = offset + entry_size * index
        kind, = struct.unpack_from('<I', data, start)
        if kind == 3:
            raise ValueError('Linux binary has PT_INTERP: ' + path.name)
        if kind == 2:
            seg_offset, = struct.unpack_from('<Q', data, start + 8)
            seg_size, = struct.unpack_from('<Q', data, start + 32)
            for pos in range(seg_offset, seg_offset + seg_size, 16):
                tag, = struct.unpack_from('<Q', data, pos)
                if tag == 1:
                    raise ValueError('Linux binary has DT_NEEDED: ' + path.name)


def verify(directory, allow_new_files=False):
    catalog_path = directory / 'catalog.json'
    required_file(catalog_path, MAX_AGENT_CATALOG_BYTES)
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    if not isinstance(catalog, list) or not catalog:
        raise ValueError('catalog must contain at least one artifact')
    # Standalone agent jobs do not yet have top-level legal assets. A complete
    # candidate does, so its archives must carry those exact bytes as well.
    release_legal_hashes = {}
    for legal_name in ('LICENSE', 'NOTICE'):
        legal_path = directory / legal_name
        if legal_path.is_file() and not legal_path.is_symlink():
            required_file(legal_path, MAX_TEXT_BYTES)
            release_legal_hashes[legal_name] = sha(legal_path)
    seen = set()
    for item in catalog:
        name = item['name']
        if name in seen or name != Path(name).name or '\\' in name or ':' in name:
            raise ValueError('unsafe or duplicate catalog name')
        seen.add(name)
        path = directory / name
        if not path.is_file() or path.is_symlink():
            raise ValueError('catalog bytes mismatch: ' + name)
        required_file(path, MAX_AGENT_BINARY_BYTES)
        if sha(path) != item['sha256'] or path.stat().st_size != item['size']:
            raise ValueError('catalog bytes mismatch: ' + name)
        if item['url'] != '/api/v1/releases/' + name:
            raise ValueError('unexpected catalog URL')
        if item['signed']:
            raise ValueError('this development verifier does not establish signature trust')
        if item['os'] == 'linux':
            static_elf(path)
        service = {
            'linux': 'packaging/systemd/vectory.service',
            'darwin': 'packaging/launchd/io.vectory.agent.plist',
            'windows': 'packaging/windows/install-service.ps1',
        }.get(item['os'])
        if service is None:
            raise ValueError('unsupported catalog OS')
        expected_members = {
            'vectory.exe' if item['os'] == 'windows' else 'vectory',
            'LICENSE', 'NOTICE', 'docs/AGENT-INSTALL.md',
            'docs/COMPATIBILITY.md', 'RELEASE-STATUS.txt', service,
        }
        archive = directory / (name[:-4] + '.zip' if name.endswith('.exe') else name + '.tar.gz')
        if not archive.is_file() or archive.is_symlink():
            raise ValueError('archive must be a regular file')
        required_file(archive, MAX_AGENT_ARCHIVE_BYTES)
        if archive.suffix == '.zip':
            required_zip_end(archive)
            try:
                with zipfile.ZipFile(archive) as z:
                    members = z.infolist()
                    validate_members([m.filename for m in members], expected_members)
                    if any(m.is_dir() or stat.S_IFMT(m.external_attr >> 16) not in (0, stat.S_IFREG) for m in members):
                        raise ValueError('archive contains a nonregular member')
                    if sum(member.file_size for member in members) > MAX_AGENT_ARCHIVE_UNPACKED_BYTES:
                        raise ValueError('archive expanded contents exceed size limit')
                    binary_sha = None
                    archive_legal_hashes = {}
                    expanded = 0
                    for member in members:
                        is_binary = member.filename == 'vectory.exe'
                        if is_binary and member.file_size > MAX_AGENT_BINARY_BYTES:
                            raise ValueError('archive binary exceeds size limit')
                        if member.filename in release_legal_hashes and member.file_size > MAX_TEXT_BYTES:
                            raise ValueError('archive legal file exceeds size limit')
                        digest = hashlib.sha256() if is_binary or member.filename in release_legal_hashes else None
                        actual = 0
                        # Reading every member to EOF makes ZipExtFile check
                        # each CRC, including docs and service material.
                        with z.open(member) as source:
                            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                                actual += len(chunk)
                                expanded += len(chunk)
                                if expanded > MAX_AGENT_ARCHIVE_UNPACKED_BYTES:
                                    raise ValueError('archive expanded contents exceed size limit')
                                if digest is not None:
                                    if actual > MAX_AGENT_BINARY_BYTES:
                                        raise ValueError('archive binary exceeds size limit')
                                    digest.update(chunk)
                        if actual != member.file_size:
                            raise ValueError('archive member length differs from ZIP inventory')
                        if is_binary:
                            binary_sha = digest.hexdigest()
                        elif member.filename in release_legal_hashes:
                            archive_legal_hashes[member.filename] = digest.hexdigest()
            except (OSError, EOFError, zipfile.BadZipFile) as error:
                raise ValueError('archive has a corrupt ZIP member') from error
        else:
            names = []
            expanded = 0
            binary_sha = None
            archive_legal_hashes = {}
            try:
                with gzip.open(archive, 'rb') as compressed:
                    source = BoundedAgentReader(compressed)
                    with tarfile.open(fileobj=source, mode='r|', tarinfo=BoundedTarInfo) as z:
                        for member in z:
                            if len(names) >= len(expected_members):
                                raise ValueError('offline archive member inventory differs from the release contract')
                            names.append(member.name)
                            if not member.isfile() or member.size < 0:
                                raise ValueError('archive contains a nonregular member')
                            expanded += member.size
                            if expanded > MAX_AGENT_ARCHIVE_UNPACKED_BYTES:
                                raise ValueError('archive expanded contents exceed size limit')
                            if member.name == 'vectory':
                                if member.size > MAX_AGENT_BINARY_BYTES:
                                    raise ValueError('archive binary exceeds size limit')
                                with z.extractfile(member) as binary_source:
                                    binary_sha = archive_binary_sha(binary_source)
                            elif member.name in release_legal_hashes:
                                if member.size > MAX_TEXT_BYTES:
                                    raise ValueError('archive legal file exceeds size limit')
                                with z.extractfile(member) as legal_source:
                                    archive_legal_hashes[member.name] = archive_binary_sha(legal_source)
                        # The tar reader stops at its first zero block. Check
                        # the second block and all padding, even if prefetched.
                        zero_tail = 0
                        for chunk in iter(lambda: z.fileobj.read(1024 * 1024), b''):
                            zero_tail += len(chunk)
                            if chunk.strip(b'\0'):
                                raise ValueError('archive has nonzero data after the tar end marker')
                        if zero_tail < 512:
                            raise ValueError('archive lacks a complete tar end marker')
                    # Reach the gzip footer too; tar iteration alone can stop
                    # before gzip notices a missing CRC or truncated trailer.
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        if chunk.strip(b'\0'):
                            raise ValueError('archive has nonzero data after the tar end marker')
            except (OSError, EOFError, tarfile.TarError) as error:
                raise ValueError('archive is not an intact gzip-compressed tar') from error
            validate_members(names, expected_members)
            if binary_sha is None:
                raise ValueError('offline archive lacks its binary')
        if binary_sha != item['sha256']:
            raise ValueError('offline archive incomplete or binary differs')
        if archive_legal_hashes != release_legal_hashes:
            raise ValueError('archive LICENSE or NOTICE differs from the release assets: ' + archive.name)
    checksum_names = set()
    checksums_path = directory / 'SHA256SUMS'
    required_file(checksums_path, MAX_AGENT_CHECKSUMS_BYTES)
    for line in checksums_path.read_text(encoding='utf-8').splitlines():
        expected, name = line.split('  ', 1)
        if name in checksum_names or name != Path(name).name or '\\' in name or ':' in name:
            raise ValueError('checksum mismatch or unsafe path')
        # Refresh is an explicit unsigned-build operation after regenerated
        # inventories. Catalog/binary/archive checks above still run first; the
        # complete new checksum set is verified again immediately after writing.
        if not allow_new_files and sha(directory / name) != expected:
            raise ValueError('checksum mismatch: ' + name)
        checksum_names.add(name)
    if not allow_new_files:
        expected_names = {p.name for p in directory.iterdir() if p.is_file() and p.name != 'SHA256SUMS' and not p.name.endswith(('.sig', '.bundle'))}
        if checksum_names != expected_names:
            raise ValueError('checksum inventory incomplete')
    return len(catalog)


def validate_members(names, expected):
    if len(names) != len(set(names)):
        raise ValueError('archive contains duplicate members')
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or str(path) != name or '\\' in name or ':' in name:
            raise ValueError('archive contains an unsafe member path')
    if set(names) != expected:
        raise ValueError('offline archive member inventory differs from the release contract')


def agent_inventory(directory):
    """Return the exact five-platform agent inventory and its one version."""
    catalog = json.loads((directory / 'catalog.json').read_text(encoding='utf-8'))
    if not isinstance(catalog, list) or len(catalog) != len(TARGETS):
        raise ValueError('release catalog must contain exactly five target agents')
    targets = {(item['os'], item['arch']) for item in catalog}
    versions = {item['version'] for item in catalog}
    if targets != TARGETS or len(versions) != 1:
        raise ValueError('release catalog targets or versions differ from the release contract')
    version = versions.pop()
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', version):
        raise ValueError('release catalog version is invalid')
    names = set()
    for item in catalog:
        os_name, arch = item['os'], item['arch']
        base = f'vectory-{version}-{os_name}-{arch}'
        binary = base + ('.exe' if os_name == 'windows' else '')
        archive = base + ('.zip' if os_name == 'windows' else '.tar.gz')
        if item['name'] != binary:
            raise ValueError('release catalog binary name differs from its target and version')
        names.update((binary, archive))
    return version, names, catalog


def required_file(path, limit):
    size = path.stat().st_size
    if not 0 < size <= limit:
        raise ValueError(f'{path.name} is empty or exceeds its offline verification size limit')


def required_json(path):
    required_file(path, MAX_JSON_BYTES)
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (UnicodeError, ValueError) as error:
        raise ValueError(f'{path.name} is not valid JSON') from error


def required_text(path, heading=None):
    required_file(path, MAX_TEXT_BYTES)
    if heading is not None:
        with path.open('r', encoding='utf-8') as source:
            if source.readline().strip() != heading:
                raise ValueError(f'{path.name} does not have its expected heading')


def required_deb(path):
    required_file(path, MAX_PACKAGE_BYTES)
    with path.open('rb') as source:
        if source.read(8) != b'!<arch>\n':
            raise ValueError(f'{path.name} is not a Debian ar package')
        header = source.read(60)
        if (len(header) != 60 or header[:16].strip().rstrip(b'/') != b'debian-binary'
                or header[58:60] != b'`\n'):
            raise ValueError(f'{path.name} has no Debian package version member')
        try:
            size = int(header[48:58].strip())
        except ValueError as error:
            raise ValueError(f'{path.name} has an invalid Debian member length') from error
        if size != 4 or source.read(4) != b'2.0\n':
            raise ValueError(f'{path.name} has an invalid Debian package version')


def required_rpm(path):
    required_file(path, MAX_PACKAGE_BYTES)
    with path.open('rb') as source:
        lead, signature_header = source.read(96), source.read(16)
        if (len(lead) != 96 or lead[:4] != b'\xed\xab\xee\xdb'
                or len(signature_header) != 16
                or signature_header[:4] != b'\x8e\xad\xe8\x01'):
            raise ValueError(f'{path.name} is not an RPM package')


def required_msi(path):
    required_file(path, MAX_PACKAGE_BYTES)
    with path.open('rb') as source:
        header = source.read(512)
        if len(header) != 512 or header[:8] != b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1':
            raise ValueError(f'{path.name} is not an MSI compound file')


class BoundedPreviewReader:
    """Bound an untrusted small starter tar before tarfile expands it."""

    def __init__(self, source, name):
        self.source = source
        self.name = name
        self.total = 0

    def read(self, size):
        if size < 0 or size > 1024 * 1024:
            raise ValueError(f'{self.name} requests an oversized preview bundle read')
        chunk = self.source.read(size)
        self.total += len(chunk)
        if self.total > MAX_PREVIEW_UNPACKED_BYTES:
            raise ValueError(f'{self.name} exceeds its expanded preview bundle size limit')
        return chunk


def required_starter_bundle(path, version, kind):
    """Require a small checksum-bound kit without duplicated image layers."""
    required_file(path, MAX_PREVIEW_BUNDLE_BYTES)
    files = STARTER_FILES[kind]
    label = 'local' if kind == 'preview' and tuple(map(int, version.split('-')[0].split('.'))) >= (0, 2, 0) else kind
    prefix = f'vectory-{version}-{label}-linux-amd64/'
    expected = {prefix + name for name in files}
    members = {}
    try:
        with gzip.open(path, 'rb') as compressed:
            source = BoundedPreviewReader(compressed, path.name)
            with tarfile.open(fileobj=source, mode='r|', tarinfo=BoundedTarInfo) as archive:
                for member in archive:
                    limit = MAX_PREVIEW_NOTICE_BYTES if member.name == prefix + 'NOTICE' else MAX_PREVIEW_MEMBER_BYTES
                    if (member.name not in expected or member.name in members
                            or not member.isfile() or not 0 < member.size <= limit
                            or member.mode != (0o755 if member.name in {prefix + 'start.sh', prefix + 'prepare-offline.sh'} else 0o644)):
                        raise ValueError(f'{path.name} has an unsafe or unexpected {kind} member: {member.name}')
                    contents = archive.extractfile(member)
                    if contents is None:
                        raise ValueError(f'{path.name} has an unreadable {kind} member')
                    data = contents.read(limit + 1)
                    if len(data) != member.size:
                        raise ValueError(f'{path.name} has an incomplete {kind} member: {member.name}')
                    members[member.name.removeprefix(prefix)] = (data, member.mode)
                # Tar iteration can stop before the gzip footer. Drain its end
                # padding and the source to reject truncated or trailing data.
                zero_tail = 0
                for chunk in iter(lambda: archive.fileobj.read(1024 * 1024), b''):
                    zero_tail += len(chunk)
                    if chunk.strip(b'\0'):
                        raise ValueError(f'{path.name} has nonzero data after the {kind} tar end marker')
                if zero_tail < 512:
                    raise ValueError(f'{path.name} lacks a complete {kind} tar end marker')
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                if chunk.strip(b'\0'):
                    raise ValueError(f'{path.name} has nonzero data after the {kind} tar end marker')
    except (OSError, EOFError, tarfile.TarError) as error:
        raise ValueError(f'{path.name} is not an intact {kind} gzip tar') from error
    if set(members) != files:
        raise ValueError(f'{path.name} {kind} member inventory differs from the release contract')
    script = 'start.sh'
    if not members[script][1] & 0o111 or not members[script][0].startswith(b'#!'):
        raise ValueError(f'{path.name} {kind} starter is not an executable shell script')
    try:
        if members['VERSION'][0].decode('utf-8').strip() != version:
            raise ValueError(f'{path.name} {kind} version differs from release agents')
        lines = members['SHA256SUMS'][0].decode('utf-8').splitlines()
    except UnicodeError as error:
        raise ValueError(f'{path.name} has non-UTF-8 {kind} metadata') from error
    sums = {}
    for line in lines:
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9._-]+)', line)
        if match is None or match.group(2) in sums:
            raise ValueError(f'{path.name} has invalid {kind} checksums')
        sums[match.group(2)] = match.group(1)
    if set(sums) != files - {'SHA256SUMS'}:
        raise ValueError(f'{path.name} {kind} checksum inventory differs')
    for name, digest in sums.items():
        if hashlib.sha256(members[name][0]).hexdigest() != digest:
            raise ValueError(f'{path.name} {kind} checksum mismatch: {name}')
    return members


class BoundedSourceReader:
    """Bound decompressed corresponding-source bytes while streaming tar."""

    def __init__(self, source):
        self.source = source
        self.total = 0

    def read(self, size):
        if size < 0 or size > 16 * 1024 * 1024:
            raise ValueError('Pagefind source archive requested an oversized read')
        chunk = self.source.read(size)
        self.total += len(chunk)
        if self.total > MAX_SOURCE_UNPACKED_BYTES:
            raise ValueError('Pagefind source archive exceeds expanded size limit')
        return chunk


class BoundedSourceTarInfo(BoundedTarInfo):
    """Allow bounded long-name records for the larger vendored source tree."""

    def _charge_extension(self, archive):
        count = getattr(archive, '_vectory_metadata_records', 0) + 1
        total = getattr(archive, '_vectory_metadata_bytes', 0) + self.size
        if (self.size < 0 or self.size > MAX_TAR_METADATA_BYTES
                or total > MAX_SOURCE_METADATA_TOTAL_BYTES or count > MAX_SOURCE_MEMBERS):
            raise ValueError('Pagefind source archive has oversized extended metadata')
        archive._vectory_metadata_records = count
        archive._vectory_metadata_bytes = total


def required_pagefind_source(directory):
    """Check pinned source metadata and every bounded archive member."""
    archive_name = 'pagefind-1.5.2-source.tar.gz'
    archive_path = directory / archive_name
    manifest = required_json(directory / 'pagefind-1.5.2-source.json')
    if (not isinstance(manifest, dict) or manifest.get('schema') != 2
            or manifest.get('component') != 'Pagefind offline Help search'
            or manifest.get('version') != '1.5.2'
            or manifest.get('upstream_commit') != PAGEFIND_COMMIT
            or not isinstance(manifest.get('upstream_source_url'), str)
            or PAGEFIND_COMMIT not in manifest['upstream_source_url']
            or manifest.get('build_recipe') != 'pagefind-1.5.2-source/REBUILD.md'):
        raise ValueError('pagefind-1.5.2-source.json does not identify the pinned corresponding source')
    bundle = manifest.get('archive')
    required_file(archive_path, MAX_SOURCE_BUNDLE_BYTES)
    if (not isinstance(bundle, dict) or bundle.get('filename') != archive_name
            or bundle.get('bytes') != archive_path.stat().st_size
            or bundle.get('sha256') != sha(archive_path)):
        raise ValueError(f'{archive_name} differs from its manifest')
    profiles = manifest.get('wasm_profiles')
    canonical = required_json(Path(__file__).resolve().parent / 'notices/pagefind-wasm-profiles.json')
    if (not isinstance(canonical, dict) or canonical.get('schema') != 1
            or not isinstance(canonical.get('profiles'), dict)
            or set(canonical['profiles']) != PAGEFIND_PROFILE_KEYS
            or profiles != canonical['profiles']):
        raise ValueError('Pagefind source manifest does not match the pinned native WASM profiles')
    for platform, profile in profiles.items():
        native = profile.get('native_package') if isinstance(profile, dict) else None
        records = profile.get('wasm') if isinstance(profile, dict) else None
        package_platform = platform.replace('win32-', 'windows-')
        binary_name = 'bin/pagefind_extended.exe' if platform.startswith('win32-') else 'bin/pagefind_extended'
        if (not isinstance(native, dict) or native.get('name') != f'@pagefind/{package_platform}'
                or native.get('version') != '1.5.2'
                or native.get('url') != f'https://registry.npmjs.org/@pagefind/{package_platform}/-/{package_platform}-1.5.2.tgz'
                or native.get('upstream_commit') != PAGEFIND_COMMIT
                or not isinstance(native.get('integrity'), str)
                or not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', native['integrity'])
                or any(not isinstance(native.get(key), str)
                       or not re.fullmatch(r'[0-9a-f]{64}', native[key])
                       for key in ('sha256', 'published_provenance_sha256', 'binary_sha256'))
                or not isinstance(native.get('bytes'), int) or not 0 < native['bytes'] <= 128 * 1024 * 1024
                or native.get('binary') != binary_name
                or native.get('published_provenance_url') !=
                f'https://registry.npmjs.org/-/npm/v1/attestations/@pagefind%2f{package_platform}@1.5.2'
                or not isinstance(records, list) or len(records) != 2
                or {record.get('filename') for record in records if isinstance(record, dict)} !=
                {'wasm.en.pagefind', 'wasm.unknown.pagefind'}):
            raise ValueError('Pagefind source manifest has an invalid native WASM profile')
        for record in records:
            if (any(not isinstance(record.get(key), str)
                    or not re.fullmatch(r'[0-9a-f]{64}', record[key])
                    for key in ('sha256', 'uncompressed_sha256', 'decoded_wasm_sha256'))
                    or any(not isinstance(record.get(key), int) or record[key] <= 0
                           for key in ('bytes', 'uncompressed_bytes', 'decoded_wasm_bytes'))
                    or not isinstance(record.get('native_binary_offset'), int)
                    or not 0 <= record['native_binary_offset'] < 256 * 1024 * 1024):
                raise ValueError('Pagefind source manifest has an invalid native WASM record')
        if platform in PAGEFIND_PLATFORM_PINS:
            pinned = PAGEFIND_PLATFORM_PINS[platform]
            if any((record['sha256'], record['bytes'], record['decoded_wasm_sha256']) !=
                   pinned[record['filename']] for record in records):
                raise ValueError('Pagefind source manifest does not match the shipped Help WASM pins')
    inputs = manifest.get('source_inputs')
    if (not isinstance(inputs, list) or len(inputs) != 23
            or any(not isinstance(item, dict) or not all(isinstance(item.get(key), str) and item[key]
                                                        for key in ('name', 'version', 'url', 'path'))
                   or not isinstance(item.get('sha256'), str)
                   or not re.fullmatch(r'[0-9a-f]{64}', item['sha256']) for item in inputs)
            or len({(item['name'], item['version']) for item in inputs}) != len(inputs)
            or not any(item['name'] == 'pagefind_web' and item['version'] == '0.0.0'
                       and item['path'] == 'upstream/pagefind_web'
                       and item.get('upstream_commit') == PAGEFIND_COMMIT for item in inputs)
            or not any(item['name'] == 'pagefind_microjson' and item['version'] == '0.1.4' for item in inputs)
            or not any(item['name'] == 'Snowball' and item['version'] == '3.0.0'
                       and item['path'] == 'snowball' and item.get('upstream_commit') == SNOWBALL_COMMIT
                       and SNOWBALL_COMMIT in item['url']
                       and item['sha256'] == SNOWBALL_SHA256 for item in inputs)):
        raise ValueError('Pagefind source manifest lacks its 22 Cargo inputs and pinned Snowball source')
    ui_inputs = manifest.get('ui_source_inputs')
    if (not isinstance(ui_inputs, list) or len(ui_inputs) != len(PAGEFIND_UI_INPUTS)
            or any(not isinstance(item, dict)
                   or item.get('name') not in PAGEFIND_UI_INPUTS
                   or item.get('version') != PAGEFIND_UI_INPUTS.get(item.get('name'))
                   or item.get('path') != f"ui-vendor/{item['name']}-{item['version']}"
                   or item.get('url') != f"https://registry.npmjs.org/{item['name']}/-/{item['name']}-{item['version']}.tgz"
                   or not isinstance(item.get('sha256'), str)
                   or not re.fullmatch(r'[0-9a-f]{64}', item['sha256'])
                   or not isinstance(item.get('integrity'), str)
                   or not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', item['integrity'])
                   for item in ui_inputs)
            or {item['name'] for item in ui_inputs} != set(PAGEFIND_UI_INPUTS)):
        raise ValueError('Pagefind source manifest lacks its five pinned UI source packages')

    prefix = 'pagefind-1.5.2-source/'
    internal_name = prefix + 'SOURCE-MANIFEST.json'
    ui_lock_name = prefix + 'upstream/pagefind_ui/default/package-lock.json'
    files = manifest.get('files')
    if not isinstance(files, list) or not 22 < len(files) <= MAX_SOURCE_MEMBERS:
        raise ValueError('Pagefind source manifest has no bounded file inventory')
    expected_files = {}
    for item in files:
        if not isinstance(item, dict):
            raise ValueError('Pagefind source manifest has an invalid file entry')
        name = item.get('path')
        if (not isinstance(name, str) or not name.startswith(prefix) or name in expected_files
                or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts
                or str(PurePosixPath(name)) != name or '\\' in name or ':' in name
                or not isinstance(item.get('sha256'), str)
                or not re.fullmatch(r'[0-9a-f]{64}', item['sha256'])
                or not isinstance(item.get('bytes'), int)
                or not 0 <= item['bytes'] <= MAX_SOURCE_MEMBER_BYTES):
            raise ValueError('Pagefind source manifest has an unsafe file entry')
        expected_files[name] = item
    if (internal_name not in expected_files or manifest['build_recipe'] not in expected_files
            or any(item['name'] != 'Snowball' and not item['path'].startswith(('vendor/', 'upstream/'))
                   or prefix + item['path'] + '/Cargo.toml' not in expected_files
                   for item in inputs if item['name'] != 'Snowball')
            or prefix + 'snowball/algorithms/english.sbl' not in expected_files
            or prefix + 'snowball/COPYING' not in expected_files
            or ui_lock_name not in expected_files
            or any(prefix + item['path'] + '/package.json' not in expected_files
                   for item in ui_inputs)):
        raise ValueError('Pagefind source manifest omits a rebuild recipe or pinned dependency')
    seen = set()
    internal_bytes = None
    ui_lock_bytes = None
    try:
        with gzip.open(archive_path, 'rb') as compressed:
            source = BoundedSourceReader(compressed)
            with tarfile.open(fileobj=source, mode='r|', tarinfo=BoundedSourceTarInfo) as archive:
                for member in archive:
                    name = member.name
                    path = PurePosixPath(name)
                    if (len(seen) >= MAX_SOURCE_MEMBERS or name in seen or not name.startswith(prefix)
                            or path.is_absolute() or '..' in path.parts or str(path) != name
                            or '\\' in name or ':' in name or not member.isfile()
                            or member.size < 0 or member.size > MAX_SOURCE_MEMBER_BYTES
                            or name not in expected_files or member.size != expected_files[name]['bytes']):
                        raise ValueError('Pagefind source archive has an unsafe or oversized member')
                    seen.add(name)
                    contents = archive.extractfile(member)
                    if contents is None:
                        raise ValueError('Pagefind source archive has an unreadable member')
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: contents.read(1024 * 1024), b''):
                        digest.update(chunk)
                        if name == internal_name:
                            if internal_bytes is None:
                                internal_bytes = bytearray()
                            internal_bytes.extend(chunk)
                        elif name == ui_lock_name:
                            if ui_lock_bytes is None:
                                ui_lock_bytes = bytearray()
                            ui_lock_bytes.extend(chunk)
                    if digest.hexdigest() != expected_files[name]['sha256']:
                        raise ValueError('Pagefind source archive member differs from its file inventory')
                zero_tail = 0
                for chunk in iter(lambda: archive.fileobj.read(1024 * 1024), b''):
                    zero_tail += len(chunk)
                    if chunk.strip(b'\0'):
                        raise ValueError('Pagefind source archive has nonzero data after tar end')
                if zero_tail < 512:
                    raise ValueError('Pagefind source archive lacks a complete tar end marker')
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                if chunk.strip(b'\0'):
                    raise ValueError('Pagefind source archive has nonzero data after tar end')
    except (OSError, EOFError, tarfile.TarError) as error:
        raise ValueError('Pagefind source archive is not an intact gzip tar') from error
    if (seen != set(expected_files) or internal_bytes is None or len(internal_bytes) > 1024 * 1024
            or ui_lock_bytes is None or len(ui_lock_bytes) > 1024 * 1024):
        raise ValueError('Pagefind source archive is missing its inventoried files or internal manifest')
    try:
        internal = json.loads(internal_bytes)
        ui_lock = json.loads(ui_lock_bytes)
    except (UnicodeError, ValueError) as error:
        raise ValueError('Pagefind source archive has an invalid internal manifest') from error
    if (not isinstance(internal, dict) or internal.get('schema') != 1
            or internal.get('upstream_commit') != PAGEFIND_COMMIT
            or internal.get('source_inputs') != inputs
            or internal.get('ui_source_inputs') != ui_inputs
            or internal.get('files') != [item for item in files if item['path'] != internal_name]):
        raise ValueError('Pagefind source archive internal manifest differs from the release manifest')
    locked = ui_lock.get('packages') if isinstance(ui_lock, dict) else None
    if (not isinstance(locked, dict)
            or any(not isinstance(locked.get('node_modules/' + item['name']), dict)
                   or locked['node_modules/' + item['name']].get('version') != item['version']
                   or locked['node_modules/' + item['name']].get('resolved') != item['url']
                   or locked['node_modules/' + item['name']].get('integrity') != item['integrity']
                   for item in ui_inputs)):
        raise ValueError('Pagefind UI source packages do not match the upstream lockfile')


class BoundedImageReader:
    """Count every expanded byte, including tar padding and trailing data."""

    def __init__(self, source, name):
        self.source = source
        self.name = name
        self.total = 0

    def read(self, size):
        if size < 0 or size > MAX_IMAGE_READ_BYTES:
            raise ValueError(f'{self.name} requests an oversized image read')
        chunk = self.source.read(size)
        self.total += len(chunk)
        if self.total > MAX_IMAGE_UNPACKED_BYTES:
            raise ValueError(f'{self.name} exceeds its expanded image size limit')
        return chunk


def image_layer_link_target(name, linkname):
    """Resolve a Docker-save layer link within the archive, never the host."""
    target = PurePosixPath(linkname)
    if (not linkname or len(linkname.encode('utf-8')) > MAX_IMAGE_PATH_BYTES
            or target.is_absolute() or str(target) != linkname
            or '\\' in linkname or ':' in linkname):
        raise ValueError('image layer has an unsafe symlink target')
    parts = list(PurePosixPath(name).parent.parts)
    for part in target.parts:
        if part == '..':
            if not parts:
                raise ValueError('image layer symlink escapes the archive')
            parts.pop()
        elif part not in ('', '.'):
            parts.append(part)
    resolved = '/'.join(parts)
    if not resolved.endswith('/layer.tar') or resolved == name:
        raise ValueError('image layer symlink does not target another layer')
    return resolved


def required_image(path):
    required_file(path, MAX_IMAGE_BYTES)
    expected_tag = f"{path.name.removesuffix('-image.tar.gz')}:candidate"
    files = {}
    layer_links = {}
    manifest_bytes = None
    unpacked = 0
    try:
        with gzip.open(path, 'rb') as compressed:
            source = BoundedImageReader(compressed, path.name)
            with tarfile.open(fileobj=source, mode='r|', tarinfo=BoundedTarInfo) as archive:
                for index, member in enumerate(archive):
                    if index >= MAX_IMAGE_MEMBERS:
                        raise ValueError(f'{path.name} has too many image members')
                    name = member.name.rstrip('/') if member.isdir() else member.name
                    normalized = PurePosixPath(name)
                    if (not name or len(name.encode('utf-8')) > MAX_IMAGE_PATH_BYTES
                            or normalized.is_absolute() or '..' in normalized.parts
                            or str(normalized) != name or '\\' in name or ':' in name
                            or name in files):
                        raise ValueError(f'{path.name} has an unsafe or duplicate image member')
                    if member.isdir():
                        files[name] = None
                        continue
                    if member.issym():
                        if not name.endswith('/layer.tar') or member.size != 0:
                            raise ValueError(f'{path.name} has a non-layer image symlink')
                        layer_links[name] = image_layer_link_target(name, member.linkname)
                        files[name] = None
                        continue
                    if not member.isfile() or member.size < 0:
                        raise ValueError(f'{path.name} has a nonregular image member')
                    unpacked += member.size
                    if unpacked > MAX_IMAGE_UNPACKED_BYTES:
                        raise ValueError(f'{path.name} exceeds its expanded image size limit')
                    if name == 'manifest.json' and member.size > MAX_IMAGE_MANIFEST_BYTES:
                        raise ValueError(f'{path.name} has an oversized Docker manifest')
                    files[name] = member.size
                    contents = archive.extractfile(member)
                    if contents is None:
                        raise ValueError(f'{path.name} has an unreadable image member')
                    if name == 'manifest.json':
                        manifest_bytes = contents.read()
                    else:
                        for chunk in iter(lambda: contents.read(1024 * 1024), b''):
                            pass
                # Tar's streaming reader may have prefetched bytes beyond the
                # end marker. Drain through it, not directly from `source`, so
                # both those buffered bytes and the remaining gzip stream are
                # checked (including the gzip CRC/footer).
                for chunk in iter(lambda: archive.fileobj.read(1024 * 1024), b''):
                    if chunk.strip(b'\0'):
                        raise ValueError(f'{path.name} has nonzero data after the tar end marker')
                if source.total < archive.offset + 1024:
                    raise ValueError(f'{path.name} has no complete tar end marker')
    except (OSError, EOFError, tarfile.TarError) as error:
        raise ValueError(f'{path.name} is not an intact gzip-compressed tar archive') from error
    if manifest_bytes is None:
        raise ValueError(f'{path.name} has no Docker-save manifest')
    try:
        manifest = json.loads(manifest_bytes)
    except (UnicodeError, ValueError) as error:
        raise ValueError(f'{path.name} has an invalid Docker-save manifest') from error
    if not isinstance(manifest, list) or len(manifest) != 1 or not isinstance(manifest[0], dict):
        raise ValueError(f'{path.name} has no single Docker image in its manifest')
    image = manifest[0]
    config, layers, tags = image.get('Config'), image.get('Layers'), image.get('RepoTags')
    if (not isinstance(config, str) or not isinstance(layers, list) or not layers
            or any(not isinstance(layer, str) for layer in layers)
            or not isinstance(tags, list) or expected_tag not in tags):
        raise ValueError(f'{path.name} has no expected Docker image or layer inventory')
    if not isinstance(files.get(config), int) or files[config] <= 0:
        raise ValueError(f'{path.name} lacks a referenced Docker image member: {config}')
    if set(layer_links) - set(layers):
        raise ValueError(f'{path.name} has an unreferenced layer symlink')
    for name in layers:
        target = layer_links.get(name, name)
        if not isinstance(files.get(target), int) or files[target] <= 0:
            raise ValueError(f'{path.name} lacks a regular referenced Docker layer: {name}')


def required_sbom(path):
    document = required_json(path)
    if path.name.endswith('.cdx.json'):
        valid = (isinstance(document, dict) and document.get('bomFormat') == 'CycloneDX'
                 and isinstance(document.get('specVersion'), str)
                 and isinstance(document.get('components'), list)
                 and any(isinstance(item, dict) and item.get('name') for item in document['components']))
    else:
        valid = (isinstance(document, dict) and document.get('spdxVersion') == 'SPDX-2.3'
                 and document.get('SPDXID') == 'SPDXRef-DOCUMENT'
                 and isinstance(document.get('packages'), list)
                 and bool(document['packages']))
    if not valid:
        raise ValueError(f'{path.name} has no usable SBOM document and components')


def non_agent_contents(directory, debs, rpms, msi, preview, serverkit, version):
    """Check bounded shape and file signatures, not native install behavior."""
    required_text(directory / 'LICENSE')
    if b'Apache License' not in (directory / 'LICENSE').read_bytes()[:1024]:
        raise ValueError('LICENSE does not contain the expected Apache License heading')
    required_text(directory / 'NOTICE', 'Vectory')
    required_pagefind_source(directory)
    for name in debs:
        required_deb(directory / name)
    for name in rpms:
        required_rpm(directory / name)
    required_msi(directory / msi)
    for name, kind in ((preview, 'preview'), (serverkit, 'server')):
        members = required_starter_bundle(directory / name, version, kind)
        for legal_name in ('LICENSE', 'NOTICE'):
            if members[legal_name][0] != (directory / legal_name).read_bytes():
                raise ValueError(f'{name} {legal_name} differs from the release asset')
    for name in ('vectory-server-image.tar.gz', 'vectory-validator-image.tar.gz'):
        required_image(directory / name)
    for name in ('vectory-server-image.spdx.json', 'vectory-validator-image.spdx.json',
                 'source.spdx.json', 'vectory-server.cdx.json', 'vectory-agent.cdx.json',
                 'vectory-dashboard.cdx.json', 'vectory-help-center.cdx.json'):
        required_sbom(directory / name)
    for name, heading in [('THIRD-PARTY-LICENSES.md', '# Third-party licenses'),
                          ('THIRD-PARTY-INVENTORY.md', '# Source dependency inventory')]:
        required_text(directory / name, heading)
    for name in ('server-without-settings.log', 'validator-without-isolation.log',
                 'install.log', 'uninstall.log'):
        required_text(directory / name)
    licenses = required_json(directory / 'license-inventory.json')
    if not (isinstance(licenses, dict) and isinstance(licenses.get('components'), list)
            and any(isinstance(item, dict) and item.get('name') for item in licenses['components'])):
        raise ValueError('license-inventory.json has no inventoried components')
    source = required_json(directory / 'SOURCE-INPUTS.json')
    if not (isinstance(source, dict) and source.get('signed') is False
            and isinstance(source.get('canonical_file_inventory_sha256'), str)
            and re.fullmatch(r'[0-9a-f]{64}', source['canonical_file_inventory_sha256'])
            and isinstance(source.get('files'), list) and bool(source['files'])):
        raise ValueError('SOURCE-INPUTS.json has no usable source inventory')
    audit = required_json(directory / 'npm-dependency-audit.json')
    if not (isinstance(audit, dict) and audit.get('gate_passed') is True
            and isinstance(audit.get('raw_audit'), dict)
            and {'dashboard', 'help-center'} <= set(audit['raw_audit'])):
        raise ValueError('npm-dependency-audit.json has no passing two-project audit')
    images = required_json(directory / 'images.json')
    if not (isinstance(images, list) and len(images) == 2
            and {tag for image in images if isinstance(image, dict)
                 for tag in image.get('RepoTags', [])} >=
            {'vectory-server:candidate', 'vectory-validator:candidate'}):
        raise ValueError('images.json does not identify both candidate images')


def candidate_inventory(directory, require_status=True):
    """Require all workflow parts; checksums alone cannot show completeness."""
    version, agents, catalog = agent_inventory(directory)
    if any(path.is_symlink() or not path.is_file() for path in directory.iterdir()):
        raise ValueError('candidate must contain only regular files, not links or directories')
    names = {path.name for path in directory.iterdir() if path.is_file()}
    core, separator, prerelease = version.partition('-')
    # These are nFPM 2.47.0's conventional filenames for the package config
    # this workflow uses (no explicit release number or name template).
    deb_version = core + ('~' + prerelease if separator else '')
    rpm_version = core + ('~' + prerelease.replace('-', '_') if separator else '')
    debs = {f'vectory_{deb_version}_{arch}.deb' for arch in ('amd64', 'arm64')}
    rpms = {f'vectory-{rpm_version}-1.{arch}.rpm' for arch in ('x86_64', 'aarch64')}
    msi = f'vectory-{version}-windows-amd64.msi'
    local_label = 'local' if tuple(map(int, core.split('.'))) >= (0, 2, 0) else 'preview'
    preview = f'vectory-{version}-{local_label}-linux-amd64.tar.gz'
    serverkit = f'vectory-{version}-server-linux-amd64.tar.gz'
    expected = REQUIRED_CANDIDATE_FILES | agents | debs | rpms | {msi, preview, serverkit}
    missing, extra = expected - names, names - expected
    if missing or extra:
        raise ValueError(f'candidate file inventory differs: missing {sorted(missing)}, extra {sorted(extra)}')
    non_agent_contents(directory, debs, rpms, msi, preview, serverkit, version)

    manifest = required_json(directory / 'CANDIDATE.json')
    if require_status and manifest.get('inventory_status') != 'complete':
        raise ValueError('candidate manifest is marked incomplete or has no inventory status')
    if manifest.get('signed') is not False or manifest.get('published') is not False:
        raise ValueError('candidate manifest must identify an unsigned, unpublished build')
    jobs = manifest.get('job_results')
    if not isinstance(jobs, dict) or set(jobs) != set(REQUIRED_JOBS) or any(
        jobs[job] != 'success' for job in REQUIRED_JOBS
    ):
        raise ValueError('candidate contains a failed, skipped or unrecorded release job')
    parts = {
        'agents': sorted(agents),
        'packages': sorted(debs | rpms),
        'msi': [msi],
        'preview': [preview],
        'serverkit': [serverkit],
        'images': ['vectory-server-image.tar.gz', 'vectory-validator-image.tar.gz'],
        'sbom': sorted(name for name in names if name.endswith('.cdx.json')),
        'legal': ['LICENSE', 'NOTICE'],
        'source': ['pagefind-1.5.2-source.json', 'pagefind-1.5.2-source.tar.gz'],
        'license_inventory': ['THIRD-PARTY-LICENSES.md'],
    }
    if manifest.get('parts') != parts:
        raise ValueError('candidate manifest parts do not match the verified file inventory')

    bundled = required_json(directory / 'image-agent-catalog.json')
    if bundled != catalog:
        raise ValueError('server image agent catalog differs from release agents')
    comparison = manifest.get('image_agents_match_release_agents')
    if comparison != {'compared': True, 'identical': True, 'differing': []}:
        raise ValueError('candidate manifest does not confirm image agent identity')


def verify_candidate(directory):
    count = verify(directory)
    candidate_inventory(directory)
    return count


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--refresh-checksums', action='store_true', help='write checksums for an agent bundle or partial diagnostic candidate; this is not release verification')
    mode.add_argument('--agent-bundle-only', action='store_true', help='verify the five agents and their archives before the remaining release jobs run')
    args = parser.parse_args()
    if args.refresh_checksums:
        count = verify(args.directory, allow_new_files=True)
        candidates = sorted(p for p in args.directory.iterdir() if p.is_file() and p.name != 'SHA256SUMS' and not p.name.endswith(('.sig', '.bundle')))
        (args.directory / 'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in candidates), encoding='utf-8')
        verify(args.directory)
        print(f'Refreshed checksums for {count} agents; candidate completeness has not been verified.')
    elif args.agent_bundle_only:
        count = verify(args.directory)
        agent_inventory(args.directory)
        print(f'Verified {count} target agents, their offline archives, checksums and Linux ELF structure. Remaining release parts have not been verified.')
    else:
        count = verify_candidate(args.directory)
        print(f'Verified complete unsigned candidate: {count} target agents, package/MSI format headers, preview and server starter bundles, Docker-save image structure, SBOMs, license inventory, successful release jobs, checksums and Linux ELF structure. This offline check does not repeat native installs, Docker loading or production TLS deployment.')
