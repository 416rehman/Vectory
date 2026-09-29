#!/usr/bin/env python3
"""Generate a source-lockfile SPDX inventory. It is not a runtime/image scan."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tomllib
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
NPM_LOCKFILES = ('dashboard/package-lock.json', 'help-center/package-lock.json')
LOCKFILES = ('server/Cargo.lock', *NPM_LOCKFILES, 'agent/go.sum')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'artifacts/releases/source.spdx.json')
    args = parser.parse_args()
    packages = []
    def add(ecosystem, name, version, license='NOASSERTION', checksum=None, location='NOASSERTION'):
        identity = hashlib.sha256(f'{ecosystem}:{name}@{version}'.encode()).hexdigest()[:24]
        package = {'SPDXID': 'SPDXRef-' + identity, 'name': name, 'versionInfo': version, 'downloadLocation': location, 'filesAnalyzed': False, 'licenseConcluded': 'NOASSERTION', 'licenseDeclared': license or 'NOASSERTION', 'copyrightText': 'NOASSERTION', 'externalRefs': [{'referenceCategory': 'PACKAGE-MANAGER', 'referenceType': 'purl', 'referenceLocator': f'pkg:{ecosystem}/{quote(name, safe="/")}@{quote(version, safe="")}'}]}
        if checksum:
            package['checksums'] = [checksum]
        packages.append(package)
    cargo = tomllib.loads((ROOT / 'server/Cargo.lock').read_text(encoding='utf-8'))
    for item in cargo['package']:
        add('cargo', item['name'], item['version'], checksum={'algorithm': 'SHA256', 'checksumValue': item['checksum']} if 'checksum' in item else None)
    for lockfile in NPM_LOCKFILES:
        npm = json.loads((ROOT / lockfile).read_text(encoding='utf-8'))
        for path, item in npm.get('packages', {}).items():
            if not path or 'version' not in item:
                continue
            name = item.get('name') or path.split('node_modules/')[-1]
            integrity = item.get('integrity', '')
            checksum = None
            if integrity.startswith('sha512-'):
                checksum = {'algorithm': 'SHA512', 'checksumValue': base64.b64decode(integrity[7:]).hex()}
            add('npm', name, item['version'], item.get('license', 'NOASSERTION'), checksum, item.get('resolved', 'NOASSERTION'))
    go_versions = set()
    for line in (ROOT / 'agent/go.sum').read_text(encoding='utf-8').splitlines():
        name, version, _ = line.split()
        if not version.endswith('/go.mod'):
            go_versions.add((name, version))
    for name, version in sorted(go_versions):
        add('golang', name, version)
    # Identical packages can occur at nested npm paths. SPDX IDs must remain unique.
    packages = list({item['SPDXID']: item for item in packages}.values())
    packages.sort(key=lambda item: item['SPDXID'])
    lock_hash = hashlib.sha256(b''.join((ROOT / rel).read_bytes() for rel in LOCKFILES)).hexdigest()
    document = {'spdxVersion': 'SPDX-2.3', 'dataLicense': 'CC0-1.0', 'SPDXID': 'SPDXRef-DOCUMENT', 'name': 'Vectory source dependency lockfile inventory', 'documentNamespace': 'https://spdx.org/spdxdocs/vectory-source-' + lock_hash, 'creationInfo': {'created': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'creators': ['Tool: Vectory lockfile inventory 1']}, 'documentComment': 'Source lockfile inventory includes development/build dependencies. Not an image/runtime SBOM, license clearance, vulnerability scan, or signed provenance. NOASSERTION license entries require maintainer review before release.', 'packages': packages, 'relationships': [{'spdxElementId': 'SPDXRef-DOCUMENT', 'relationshipType': 'DESCRIBES', 'relatedSpdxElement': item['SPDXID']} for item in packages]}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=2) + '\n', encoding='utf-8')
    inventory = args.out.with_name('THIRD-PARTY-INVENTORY.md')
    inventory.write_text('# Source dependency inventory\n\nGenerated from ' + ', '.join(f'`{name}`' for name in LOCKFILES) + '. Includes build/development packages; NOASSERTION requires license review. See the SPDX document for exact source hashes where lockfiles supply them.\n\n| Package | Version | Declared license |\n| --- | --- | --- |\n' + ''.join(f'| {p["name"]} | {p["versionInfo"]} | {p["licenseDeclared"]} |\n' for p in sorted(packages, key=lambda p: (p['name'], p['versionInfo']))), encoding='utf-8')
    print(f'Generated source SPDX inventory for {len(packages)} dependencies; license review and runtime/image scan remain separate gates.')


if __name__ == '__main__':
    main()
