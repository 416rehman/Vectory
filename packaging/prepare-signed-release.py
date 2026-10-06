#!/usr/bin/env python3
"""Validate and describe a CI-signed distribution without changing built binaries."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
ISSUER = 'https://token.actions.githubusercontent.com'


def stable_tag(ref, version):
    if not re.fullmatch(r'refs/tags/v[0-9]+\.[0-9]+\.[0-9]+', ref or ''):
        raise ValueError('signed publication requires an exact stable version tag')
    if ref != 'refs/tags/v' + version:
        raise ValueError('tag differs from the checked-in agent version')
    return ref.removeprefix('refs/tags/')


def source_version():
    return re.search(r'^const Version = "([^"]+)"$', (ROOT / 'agent/internal/agent/types.go').read_text(), re.M).group(1)


def checked_images(path):
    values = {}
    for line in path.read_text().splitlines():
        name, separator, value = line.partition('=')
        component = {'VECTORY_SERVER_IMAGE': 'server', 'VECTORY_VALIDATOR_IMAGE': 'validator'}.get(name)
        if not separator or not component or name in values or not re.fullmatch(
                'ghcr.io/416rehman/vectory-' + component + r'@sha256:[a-f0-9]{64}', value):
            raise ValueError('image inventory contains an invalid, repeated or mutable reference')
        values[name] = value
    if set(values) != {'VECTORY_SERVER_IMAGE', 'VECTORY_VALIDATOR_IMAGE'}:
        raise ValueError('both immutable release images are required')
    return values


def checked_image_configs(path):
    images = json.loads(path.read_text())
    if not isinstance(images, list) or len(images) != 2:
        raise ValueError('image metadata must contain exactly both candidate images')
    configs = {}
    for image in images:
        tags = image.get('RepoTags')
        component = next((name for name in ('server', 'validator') if tags == ['vectory-' + name + ':candidate']), None)
        identity = image.get('Id', '')
        if not component or component in configs or not re.fullmatch(r'sha256:[a-f0-9]{64}', identity):
            raise ValueError('candidate image configuration identities are invalid or repeated')
        configs[component] = identity
    if set(configs) != {'server', 'validator'}:
        raise ValueError('both candidate image configuration identities are required')
    return configs


def archive_config_digest(folder, component):
    metadata = {}
    metadata_bytes = 0
    with tarfile.open(folder / ('vectory-' + component + '-image.tar.gz'), mode='r|gz') as archive:
        for member in archive:
            if member.isfile() and member.size <= 4 * 1024 * 1024:
                source = archive.extractfile(member)
                data = source.read()
                metadata[member.name] = data
                metadata_bytes += len(data)
                if metadata_bytes > 64 * 1024 * 1024:
                    raise ValueError('saved image has oversized metadata')
    manifest = json.loads(metadata['manifest.json'])
    if not isinstance(manifest, list) or len(manifest) != 1 or manifest[0].get('RepoTags') != ['vectory-' + component + ':candidate']:
        raise ValueError('saved archive does not identify exactly its candidate image')
    config = metadata[manifest[0]['Config']]
    document = json.loads(config)
    if document.get('architecture') != 'amd64' or document.get('os') != 'linux':
        raise ValueError('saved image is not Linux amd64')
    return 'sha256:' + hashlib.sha256(config).hexdigest()


def write_image_configs(folder):
    configs = {component: archive_config_digest(folder, component) for component in ('server', 'validator')}
    (folder / 'IMAGE-CONFIGS.env').write_text(''.join(
        'VECTORY_' + component.upper() + '_IMAGE=' + configs[component] + '\n'
        for component in ('server', 'validator')))
    return configs


def scan_findings(document):
    if document.get('SchemaVersion') != 2 or not isinstance(document.get('Results'), list):
        raise ValueError('image vulnerability scan has no complete Trivy v2 result')
    blocked = []
    counts = {}
    for result in document['Results']:
        for finding in result.get('Vulnerabilities') or []:
            severity = finding['Severity']
            counts[severity] = counts.get(severity, 0) + 1
            if severity == 'CRITICAL' or (severity == 'HIGH' and finding.get('FixedVersion')):
                blocked.append(finding['VulnerabilityID'] + ':' + finding['PkgName'])
    if blocked:
        raise ValueError('critical or fixable high image findings: ' + ', '.join(sorted(set(blocked))))
    return counts


def scan_gate(folder):
    summaries = {}
    for component in ('server', 'validator', 'proxy'):
        path = folder / (component + '-image-vulnerabilities.json')
        summaries[component] = scan_findings(json.loads(path.read_text()))
    return summaries


def inventory(folder):
    files = sorted(p for p in folder.iterdir() if p.name not in {'SHA256SUMS', 'SHA256SUMS.sigstore.json'})
    if any(not p.is_file() or p.is_symlink() or not re.fullmatch(r'[A-Za-z0-9_.-]+', p.name) for p in files):
        raise ValueError('release inventory must contain safe regular files')
    lines = []
    for path in files:
        with path.open('rb') as source:
            lines.append(hashlib.file_digest(source, 'sha256').hexdigest() + '  ' + path.name + '\n')
    return ''.join(lines)


def main():
    command = sys.argv[1]
    folder = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if command == 'scan-gate':
        print(json.dumps(scan_gate(folder), indent=2))
        return
    if command == 'image-configs':
        write_image_configs(folder)
        return
    version = source_version()
    tag = stable_tag(os.environ.get('RELEASE_REF'), version)
    identity = 'https://github.com/416rehman/Vectory/.github/workflows/release.yml@refs/tags/' + tag
    if command == 'check-tag':
        print('Release identity: ' + identity)
    elif command == 'check-source':
        candidate = json.loads((folder / 'CANDIDATE.json').read_text())
        if candidate.get('commit') != os.environ['GITHUB_SHA']:
            raise ValueError('candidate source commit differs from the release workflow')
    elif command == 'finalize':
        configs = write_image_configs(folder)
        distribution = {
            'version': version, 'commit': os.environ['GITHUB_SHA'],
            'workflow_run': 'https://github.com/416rehman/Vectory/actions/runs/' + os.environ['GITHUB_RUN_ID'],
            'images': checked_images(folder / 'IMAGE-DIGESTS.env'),
            'image_config_ids': configs,
            'candidate_image_ids': checked_image_configs(folder / 'images.json'),
            'signature': {'type': 'sigstore-keyless', 'identity': identity, 'issuer': ISSUER,
                          'inventory': 'SHA256SUMS', 'bundle': 'SHA256SUMS.sigstore.json'},
            'native_os_signing': {'authenticode': False, 'apple_developer_id_notarization': False},
            'image_vulnerability_records': scan_gate(folder),
            'note': 'Cosign authenticates published bytes and workflow identity. It does not establish native OS code-signing trust or freedom from vulnerabilities.',
        }
        (folder / 'RELEASE.json').write_text(json.dumps(distribution, indent=2) + '\n')
        (folder / 'SHA256SUMS').write_text(inventory(folder))
    elif command == 'notes':
        release = json.loads((folder / 'RELEASE.json').read_text())
        print(f'''Vectory {version} is a self-hosted control plane for Vector.

## Install

Use the [guided quickstart](https://vectory.ahmadz.ai/help/quickstart/). Download `vectory-{version}-server-linux-amd64.tar.gz`, extract it, and run `./start.sh` on a Linux x86-64 Docker host. The kit verifies release signatures, pulls immutable images from GHCR, and guides first administrator setup. No source compilation is needed.

The native Linux x86-64 server kit is `vectory-{version}-server-native-linux-amd64.tar.gz`. It installs the same prebuilt server, dashboard and agents with an isolated systemd validator, without Docker or a compiler. Use [the native installation guide](https://vectory.ahmadz.ai/help/install-server/) for the supported host requirements and signature-verifying one-command installer. `vectory-{version}-native-runtime-source.tar.gz` separately retains the exact corresponding Debian runtime sources; ordinary installation does not need that optional source archive. The public native installer and exact runtime/source provenance are included as signed release assets.

The local evaluation kit is separate. Managed devices need an existing supported Vector installation; Add device provides the platform download and setup command.

## Verify

`SHA256SUMS.sigstore.json` authenticates `SHA256SUMS` using GitHub OIDC and Sigstore. `IMAGE-DIGESTS.env` contains the immutable server and validator references. Both images carry Cosign signatures. Verify the certificate identity `{identity}` and issuer `{ISSUER}`. The starter does this through a pinned Cosign container, with no host Cosign installation.

Built-in agent-update catalog signatures use a separate operator key and are not enabled by this release signature. Windows Authenticode and Apple Developer ID/notarization are not present; operating systems may show trust prompts even though the download has a verified Sigstore signature.

## Validation and operational limits

Publication requires all application, native service, package, isolated validator, starter TLS/bootstrap/restart, provenance and signature gates on this tag. File download or writing configuration is not verified device activation.

Container scans reject every critical record and every high record with an available fix. Unfixed findings remain disclosed in the three `*-image-vulnerabilities.json` files and summarized in `RELEASE.json`. Counts are package records, not proof of exploitability or safety. Use least privilege, backups, restricted dashboard access and your deployment review process.

This release supports a Linux x86-64 Docker Compose manager, Linux amd64/arm64 agents, macOS Intel/Apple Silicon agent downloads and Windows amd64 agents. Consult the [tested compatibility matrix](https://vectory.ahmadz.ai/help/compatibility/) before production rollout. Native tests cannot cover every OS or workload.

Source: `{release['commit']}`. [CI receipt]({release['workflow_run']}). Vectory is independent of Datadog and the Vector project.''')
    else:
        raise ValueError('unknown operation')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, IndexError) as error:
        sys.exit(str(error))
