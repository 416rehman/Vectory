#!/usr/bin/env python3
"""Write CANDIDATE.json for an assembled release-candidate folder.

Records the commit and workflow run, which parts are present and whether their
jobs passed, the pinned tools, and whether the server-image and standalone
agent catalogs agree. The image job separately hashes the embedded binaries
against its catalog, so a successful workflow establishes byte identity. This
manifest alone is not proof of that job or a provenance attestation. It states
signed:false and published:false.
"""
import argparse
import json
import os
import re
import runpy
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
    try:
        catalogs = []
        for path in (built, bundled):
            if path.stat().st_size > 1024 * 1024:
                raise ValueError('catalog exceeds 1 MiB')
            items = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(items, list) or any(
                not isinstance(item, dict) or not isinstance(item.get('name'), str)
                or not isinstance(item.get('sha256'), str) for item in items
            ):
                raise ValueError('catalog is not a release list')
            catalogs.append({item['name']: item['sha256'] for item in items})
        left, right = catalogs
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        return {'compared': False, 'reason': f'catalog comparison unavailable: {type(error).__name__}'}
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
    path = args.folder / 'CANDIDATE.json'
    path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    # Assembly deliberately saves an incomplete candidate when another job
    # failed. Use the same inventory check as the offline verifier to mark that
    # artifact prominently, without failing assembly before it can be uploaded.
    try:
        runpy.run_path(str(Path(__file__).with_name('verify-release.py')))['candidate_inventory'](args.folder, require_status=False)
    except (ValueError, KeyError, TypeError, FileNotFoundError, json.JSONDecodeError) as error:
        manifest['inventory_status'] = 'incomplete-diagnostic'
        manifest['inventory_problem'] = str(error)
        manifest['note'] = 'INCOMPLETE DIAGNOSTIC ARTIFACT. Do not publish this folder as a release candidate.'
        print(f'::warning::{manifest["note"]} {error}')
    else:
        manifest['inventory_status'] = 'complete'
    path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: manifest[k] for k in ('inventory_status', 'parts', 'job_results', 'image_agents_match_release_agents')}, indent=2))


if __name__ == '__main__':
    main()
