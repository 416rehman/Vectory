#!/usr/bin/env python3
"""Verify actual catalog bytes, archive contents, and static Linux ELF structure."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import struct
import tarfile
import zipfile


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


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
    catalog = json.loads((directory / 'catalog.json').read_text(encoding='utf-8'))
    if not isinstance(catalog, list) or not catalog:
        raise ValueError('catalog must contain at least one artifact')
    seen = set()
    for item in catalog:
        name = item['name']
        if name in seen or name != Path(name).name or '\\' in name or ':' in name:
            raise ValueError('unsafe or duplicate catalog name')
        seen.add(name)
        path = directory / name
        if not path.is_file() or path.is_symlink() or sha(path) != item['sha256'] or path.stat().st_size != item['size']:
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
        if archive.suffix == '.zip':
            with zipfile.ZipFile(archive) as z:
                members = z.infolist()
                validate_members([m.filename for m in members], expected_members)
                if any(m.is_dir() or stat.S_IFMT(m.external_attr >> 16) not in (0, stat.S_IFREG) for m in members):
                    raise ValueError('archive contains a nonregular member')
                binary = z.read('vectory.exe')
        else:
            with tarfile.open(archive) as z:
                members = z.getmembers()
                validate_members([m.name for m in members], expected_members)
                if any(not m.isfile() for m in members):
                    raise ValueError('archive contains a nonregular member')
                binary = z.extractfile('vectory').read()
        if binary != path.read_bytes():
            raise ValueError('offline archive incomplete or binary differs')
    checksum_names = set()
    for line in (directory / 'SHA256SUMS').read_text(encoding='utf-8').splitlines():
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--refresh-checksums', action='store_true', help='include newly generated SBOM/provenance before signing')
    args = parser.parse_args()
    count = verify(args.directory, allow_new_files=args.refresh_checksums)
    if args.refresh_checksums:
        candidates = sorted(p for p in args.directory.iterdir() if p.is_file() and p.name != 'SHA256SUMS' and not p.name.endswith(('.sig', '.bundle')))
        (args.directory / 'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in candidates), encoding='utf-8')
        verify(args.directory)
    print(f'Verified {count} unsigned artifacts, catalog, offline archives, checksums and Linux ELF dependency structure. Native compatibility remains unverified.')
