#!/usr/bin/env python3
"""Check extracted server-image agent bytes against the image's own catalog.

The release assembler compares that catalog with the standalone agent catalog.
This check makes the comparison a claim about the actual embedded binaries.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


TARGETS = {('linux', 'amd64'), ('linux', 'arm64'), ('darwin', 'amd64'),
           ('darwin', 'arm64'), ('windows', 'amd64')}
MAX_CATALOG_BYTES = 1024 * 1024
MAX_AGENT_BYTES = 512 * 1024 * 1024


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def check(directory):
    catalog_path = directory / 'catalog.json'
    if not catalog_path.is_file() or catalog_path.is_symlink() or not 0 < catalog_path.stat().st_size <= MAX_CATALOG_BYTES:
        raise ValueError('server image has no bounded regular agent catalog')
    try:
        catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    except (UnicodeError, ValueError) as error:
        raise ValueError('server image agent catalog is invalid JSON') from error
    if not isinstance(catalog, list) or len(catalog) != len(TARGETS):
        raise ValueError('server image must bundle exactly five catalog agents')
    targets = set()
    names = set()
    versions = set()
    for item in catalog:
        if not isinstance(item, dict):
            raise ValueError('server image agent catalog has an invalid entry')
        try:
            os_name, arch, version, name = (item[key] for key in ('os', 'arch', 'version', 'name'))
            digest, size = item['sha256'], item['size']
        except KeyError as error:
            raise ValueError('server image agent catalog has an incomplete entry') from error
        if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', version):
            raise ValueError('server image agent version is invalid')
        if not isinstance(os_name, str) or not isinstance(arch, str):
            raise ValueError('server image agent target is invalid')
        if (os_name, arch) not in TARGETS or (os_name, arch) in targets:
            raise ValueError('server image agent targets are missing or duplicated')
        expected = f'vectory-{version}-{os_name}-{arch}' + ('.exe' if os_name == 'windows' else '')
        if (name != expected or item.get('url') != '/api/v1/releases/' + expected
                or item.get('signed') is not False or name in names):
            raise ValueError('server image agent catalog identity is inconsistent')
        if (not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest)
                or not isinstance(size, int) or isinstance(size, bool)
                or not 0 < size <= MAX_AGENT_BYTES):
            raise ValueError('server image agent catalog has an invalid digest or size')
        binary = directory / name
        if (not binary.is_file() or binary.is_symlink()
                or binary.stat().st_size != size or sha256(binary) != digest):
            raise ValueError(f'server image agent bytes differ from catalog: {name}')
        targets.add((os_name, arch))
        names.add(name)
        versions.add(version)
    if targets != TARGETS or len(versions) != 1:
        raise ValueError('server image agent targets or versions differ')
    actual = {path.name for path in directory.iterdir() if path.is_file() and not path.is_symlink()}
    if actual != names | {'catalog.json', 'SHA256SUMS'} or any(
        path.is_symlink() or not path.is_file() for path in directory.iterdir()
    ):
        raise ValueError('server image agent directory contains missing or unexpected entries')
    return len(names)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    print(f'Checked {check(args.directory)} embedded server-image agent binaries against their catalog.')
