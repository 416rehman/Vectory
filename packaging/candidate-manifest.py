#!/usr/bin/env python3
"""Write CANDIDATE.json for an assembled release-candidate folder.

Records the commit and workflow run, which parts are present and whether their
jobs passed, the pinned tools, and whether the agents bundled in the server
image are byte-identical to the separately built ones. It states signed:false
and published:false; it is not a provenance attestation.
"""
import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

AGENT = re.compile(r'^vectory-[0-9][^/]*-(linux|darwin|windows)-(amd64|arm64)(\.exe|\.tar\.gz|\.zip)?$')
PARTS = {
    'agents': lambda n: bool(AGENT.match(n)),
    'packages': lambda n: n.endswith(('.deb', '.rpm')),
    'msi': lambda n: n.endswith('.msi'),
    'images': lambda n: n.endswith('-image.tar.gz'),
    'sbom': lambda n: n.endswith('.cdx.json'),
    'license_inventory': lambda n: n == 'THIRD-PARTY-LICENSES.md',
}
RESULTS = {'packages': 'PACKAGES_RESULT', 'msi': 'MSI_RESULT', 'images': 'IMAGES_RESULT', 'sbom': 'SBOM_RESULT'}
TOOLS = ('NFPM_VERSION', 'NFPM_SUM', 'CYCLONEDX_GOMOD_VERSION', 'CYCLONEDX_GOMOD_SUM', 'CARGO_CYCLONEDX_VERSION', 'WIX_VERSION', 'DEBIAN_IMAGE', 'ALMALINUX_IMAGE')


def reproducibility(folder):
    """Compare the image's bundled agent catalog with the separately built catalog."""
    built, bundled = folder / 'catalog.json', folder / 'image-agent-catalog.json'
    if not built.is_file() or not bundled.is_file():
        return {'compared': False, 'reason': 'one of the catalogs is missing'}
    left = {item['name']: item['sha256'] for item in json.loads(built.read_text(encoding='utf-8'))}
    right = {item['name']: item['sha256'] for item in json.loads(bundled.read_text(encoding='utf-8'))}
    differing = sorted(name for name in left.keys() | right.keys() if left.get(name) != right.get(name))
    return {'compared': True, 'identical': not differing, 'differing': differing}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    args = parser.parse_args()
    names = sorted(p.name for p in args.folder.iterdir() if p.is_file())
    env = os.environ
    server, repository, run = env.get('GITHUB_SERVER_URL', ''), env.get('GITHUB_REPOSITORY', ''), env.get('GITHUB_RUN_ID', '')
    manifest = {
        'created_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'signed': False,
        'published': False,
        'commit': env.get('GITHUB_SHA'),
        'ref': env.get('GITHUB_REF'),
        'workflow_run': f'{server}/{repository}/actions/runs/{run}' if run else None,
        'run_attempt': env.get('GITHUB_RUN_ATTEMPT'),
        'parts': {part: sorted(n for n in names if match(n)) for part, match in PARTS.items()},
        'job_results': {part: env.get(variable) for part, variable in RESULTS.items()},
        'tools': {name.lower(): env.get(name) for name in TOOLS if env.get(name)},
        'image_agents_match_release_agents': reproducibility(args.folder),
        'note': 'Unsigned development candidate. Signing, notarization, package repositories and publication are separate maintainer steps.',
    }
    (args.folder / 'CANDIDATE.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    missing = [part for part, files in manifest['parts'].items() if not files]
    if missing:
        print(f'::warning::The candidate has no {", ".join(missing)}; see job_results in CANDIDATE.json.')
    check = manifest['image_agents_match_release_agents']
    if check.get('compared') and not check['identical']:
        print(f'::warning::Agents bundled in the image differ from the release agents: {", ".join(check["differing"])}')
    print(json.dumps({k: manifest[k] for k in ('parts', 'job_results', 'image_agents_match_release_agents')}, indent=2))


if __name__ == '__main__':
    main()
