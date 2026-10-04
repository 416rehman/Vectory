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
REQUIRED_JOBS = ('packages', 'msi', 'images', 'sbom')
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
                    expanded = 0
                    for member in members:
                        is_binary = member.filename == 'vectory.exe'
                        if is_binary and member.file_size > MAX_AGENT_BINARY_BYTES:
                            raise ValueError('archive binary exceeds size limit')
                        digest = hashlib.sha256() if is_binary else None
                        actual = 0
                        # Reading every member to EOF makes ZipExtFile check
                        # each CRC, including docs and service material.
                        with z.open(member) as source:
                            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                                actual += len(chunk)
                                expanded += len(chunk)
                                if expanded > MAX_AGENT_ARCHIVE_UNPACKED_BYTES:
                                    raise ValueError('archive expanded contents exceed size limit')
                                if is_binary:
                                    if actual > MAX_AGENT_BINARY_BYTES:
                                        raise ValueError('archive binary exceeds size limit')
                                    digest.update(chunk)
                        if actual != member.file_size:
                            raise ValueError('archive member length differs from ZIP inventory')
                        if is_binary:
                            binary_sha = digest.hexdigest()
            except (OSError, EOFError, zipfile.BadZipFile) as error:
                raise ValueError('archive has a corrupt ZIP member') from error
        else:
            names = []
            expanded = 0
            binary_sha = None
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


def non_agent_contents(directory, debs, rpms, msi):
    """Check bounded shape and file signatures, not native install behavior."""
    for name in debs:
        required_deb(directory / name)
    for name in rpms:
        required_rpm(directory / name)
    required_msi(directory / msi)
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
    expected = REQUIRED_CANDIDATE_FILES | agents | debs | rpms | {msi}
    missing, extra = expected - names, names - expected
    if missing or extra:
        raise ValueError(f'candidate file inventory differs: missing {sorted(missing)}, extra {sorted(extra)}')
    non_agent_contents(directory, debs, rpms, msi)

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
        'images': ['vectory-server-image.tar.gz', 'vectory-validator-image.tar.gz'],
        'sbom': sorted(name for name in names if name.endswith('.cdx.json')),
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
        print(f'Verified complete unsigned candidate: {count} target agents, package/MSI format headers, Docker-save image structure, SBOMs, license inventory, successful release jobs, checksums and Linux ELF structure. Native installs and docker load remain separate gates.')
