#!/usr/bin/env python3
"""Merge CycloneDX JSON SBOMs into one third-party license inventory.

Writes THIRD-PARTY-LICENSES.md and license-inventory.json. A component whose
SBOM carries no license is listed under "needs review"; nothing is guessed.
It is an inventory, not license clearance.
"""
import argparse
import json
from pathlib import Path


def licenses_of(component):
    found = []
    for entry in component.get('licenses') or []:
        if 'expression' in entry:
            found.append(entry['expression'])
        else:
            license = entry.get('license') or {}
            found.append(license.get('id') or license.get('name') or '')
    return sorted({value for value in found if value})


def ecosystem_of(component):
    purl = component.get('purl') or ''
    return purl[4:].split('/', 1)[0] if purl.startswith('pkg:') else 'unknown'


def components_of(document, source):
    rows = []
    stack = list(document.get('components') or [])
    while stack:
        component = stack.pop()
        stack.extend(component.get('components') or [])
        rows.append({
            'ecosystem': ecosystem_of(component),
            'name': (component.get('group') + '/' if component.get('group') else '') + component['name'],
            'version': component.get('version', ''),
            'licenses': licenses_of(component),
            'purl': component.get('purl', ''),
            'sbom': source,
        })
    return rows


def inventory(paths):
    rows = {}
    for path in paths:
        document = json.loads(Path(path).read_text(encoding='utf-8'))
        if document.get('bomFormat') != 'CycloneDX':
            raise SystemExit(f'{path} is not a CycloneDX JSON document')
        found = components_of(document, Path(path).name)
        if not found:
            raise SystemExit(f'{path} lists no components')
        for row in found:
            key = (row['ecosystem'], row['name'], row['version'])
            if key in rows:
                rows[key]['licenses'] = sorted(set(rows[key]['licenses']) | set(row['licenses']))
            else:
                rows[key] = row
    return sorted(rows.values(), key=lambda r: (r['ecosystem'], r['name'].lower(), r['version']))


def markdown(rows):
    review = [r for r in rows if not r['licenses']]
    counts = {}
    for row in rows:
        for license in row['licenses'] or ['(none recorded)']:
            counts[license] = counts.get(license, 0) + 1
    lines = [
        '# Third-party licenses',
        '',
        f'{len(rows)} components from the CycloneDX SBOMs of this build. Licenses are as each '
        'package declares them; this is an inventory for review, not license clearance.',
        '',
        '| License | Components |',
        '| --- | --- |',
        *[f'| {license} | {count} |' for license, count in sorted(counts.items(), key=lambda i: (-i[1], i[0]))],
        '',
        f'## Needs review ({len(review)})',
        '',
        *([f'- {r["ecosystem"]} {r["name"]} {r["version"]}: no license in its SBOM' for r in review] or ['None.']),
        '',
        '## Components',
        '',
        '| Ecosystem | Component | Version | License |',
        '| --- | --- | --- | --- |',
        *[f'| {r["ecosystem"]} | {r["name"]} | {r["version"]} | {", ".join(r["licenses"]) or "not recorded"} |' for r in rows],
        '',
    ]
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sboms', nargs='+', type=Path)
    parser.add_argument('--out', type=Path, required=True, help='folder for THIRD-PARTY-LICENSES.md and license-inventory.json')
    args = parser.parse_args()
    rows = inventory(args.sboms)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'THIRD-PARTY-LICENSES.md').write_text(markdown(rows), encoding='utf-8')
    (args.out / 'license-inventory.json').write_text(json.dumps({'components': rows}, indent=2) + '\n', encoding='utf-8')
    review = sum(1 for r in rows if not r['licenses'])
    print(f'Inventoried {len(rows)} components from {len(args.sboms)} SBOMs; {review} need license review.')


if __name__ == '__main__':
    main()
