#!/usr/bin/env python3
"""Authenticate the public release advertised by a website deployment."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

REPOSITORY = '416rehman/Vectory'
ISSUER = 'https://token.actions.githubusercontent.com'
METADATA_LIMIT = 64 * 1024
RELEASE_LIMIT = 2 * 1024 * 1024
BASE_FILES = {'SHA256SUMS', 'SHA256SUMS.sigstore.json', 'IMAGE-DIGESTS.env',
              'IMAGE-CONFIGS.env', 'RELEASE.json'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def json_document(data):
    try:
        return json.loads(data.decode('utf-8'))
    except (UnicodeError, ValueError):
        raise ValueError('Public release metadata is not valid UTF-8 JSON') from None


def fetch_bytes(url, limit):
    request = urllib.request.Request(url, headers={'User-Agent': 'Vectory-site-release-verifier'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            final = urllib.parse.urlsplit(response.url)
            require(final.scheme == 'https' and final.hostname in {
                'api.github.com', 'github.com', 'release-assets.githubusercontent.com',
                'objects.githubusercontent.com'}, 'Public metadata redirected outside GitHub')
            data = response.read(limit + 1)
    except (OSError, ValueError):
        raise ValueError('Could not read bounded public release metadata') from None
    require(len(data) <= limit, 'Public release metadata exceeds its bound')
    return data


def cosign_verify(arguments, directory):
    environment = {key: value for key, value in os.environ.items()
                   if not re.search(r'TOKEN|SECRET|PASSWORD|PASSWD', key, re.I)}
    cache = directory / 'verifier-cache'
    docker = directory / 'anonymous-docker'
    cache.mkdir(mode=0o700, exist_ok=True)
    docker.mkdir(mode=0o700, exist_ok=True)
    environment.update({'HOME': str(cache), 'USERPROFILE': str(cache),
                        'SIGSTORE_CACHE_DIR': str(cache / 'sigstore'),
                        'DOCKER_CONFIG': str(docker)})
    try:
        result = subprocess.run(['cosign', *arguments], env=environment,
                                capture_output=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('Public release signature verifier was unavailable') from None
    require(len(result.stdout) + len(result.stderr) <= 1024 * 1024,
            'Public release signature verifier exceeded its output bound')
    require(result.returncode == 0, 'Public release signature verification failed')


def required_files(version):
    required = set(BASE_FILES)
    if tuple(map(int, version.split('.'))) >= (0, 2, 1):
        required |= {'install.sh', 'install-desktop.sh', 'install.ps1', 'install-native.sh',
                     f'vectory-{version}-server-linux-amd64.tar.gz',
                     f'vectory-{version}-server-native-linux-amd64.tar.gz',
                     f'vectory-{version}-native-runtime-source.tar.gz',
                     'native-kit-provenance.json', 'native-runtime-source.json', 'native-smoke.json'}
    return required


def checked_inventory(data, public_names):
    try:
        lines = data.decode('utf-8').splitlines()
    except UnicodeError:
        raise ValueError('Signed release inventory is not valid UTF-8') from None
    entries = {}
    for line in lines:
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_.-]+)', line)
        require(match is not None, 'Signed release inventory contains an unsafe entry')
        digest, name = match.groups()
        require(name not in entries, 'Signed release inventory contains a duplicate entry')
        entries[name] = digest
    require(set(entries) == public_names - {'SHA256SUMS', 'SHA256SUMS.sigstore.json'},
            'Signed inventory and public release assets differ')
    return entries


def checked_images(data):
    try:
        lines = data.decode('utf-8').splitlines()
    except UnicodeError:
        raise ValueError('Signed image references are not valid UTF-8') from None
    images = {}
    for line in lines:
        match = re.fullmatch(r'VECTORY_(SERVER|VALIDATOR)_IMAGE='
                            r'(ghcr\.io/416rehman/vectory-(server|validator)@sha256:[a-f0-9]{64})', line)
        require(match is not None, 'Signed image reference is not an immutable Vectory digest')
        name, image, component = match.groups()
        require(name.lower() == component and name not in images,
                'Signed image references are duplicate or inconsistent')
        images[name] = image
    require(set(images) == {'SERVER', 'VALIDATOR'}, 'Both signed release images are required')
    return {'VECTORY_' + name + '_IMAGE': image for name, image in images.items()}


def verify_release(metadata, version, directory, fetch=fetch_bytes, verify=cosign_verify):
    require(re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version),
            'Website release version is not an exact stable version')
    require(isinstance(metadata, dict) and isinstance(metadata.get('assets'), list),
            'Public release metadata has an invalid shape')
    require(type(metadata.get('draft')) is bool and type(metadata.get('prerelease')) is bool,
            'Public release publication state is invalid')
    tag = 'v' + version
    if metadata.get('tag_name') != tag or metadata['draft'] or metadata['prerelease']:
        return {'ready': False, 'reason': 'Matching public stable release is unavailable'}
    assets = {}
    for asset in metadata['assets']:
        require(isinstance(asset, dict), 'Public release asset has an invalid shape')
        name = asset.get('name')
        require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', name)
                and name not in {'.', '..'} and name not in assets,
                'Public release assets have unsafe or duplicate names')
        expected = f'https://github.com/{REPOSITORY}/releases/download/{tag}/{name}'
        require(asset.get('browser_download_url') == expected,
                'Public release asset does not use its exact GitHub download URL')
        require(type(asset.get('size')) is int and asset['size'] > 0,
                'Public release asset size is invalid')
        assets[name] = asset
    if not required_files(version) <= assets.keys():
        return {'ready': False, 'reason': 'Required signed release assets are unavailable'}
    identity = f'https://github.com/{REPOSITORY}/.github/workflows/release.yml@refs/tags/{tag}'
    payloads = {}
    for name in ('SHA256SUMS', 'SHA256SUMS.sigstore.json'):
        require(assets[name]['size'] <= METADATA_LIMIT, 'Signature metadata exceeds its bound')
        payloads[name] = fetch(assets[name]['browser_download_url'], METADATA_LIMIT)
        require(len(payloads[name]) == assets[name]['size'], 'Signature metadata size changed')
        (directory / name).write_bytes(payloads[name])
    verify(['verify-blob', '--bundle', str(directory / 'SHA256SUMS.sigstore.json'),
            '--certificate-identity', identity, '--certificate-oidc-issuer', ISSUER,
            str(directory / 'SHA256SUMS')], directory)
    inventory = checked_inventory(payloads['SHA256SUMS'], set(assets))
    for name in ('RELEASE.json', 'IMAGE-DIGESTS.env'):
        require(assets[name]['size'] <= METADATA_LIMIT, 'Signed public metadata exceeds its bound')
        payloads[name] = fetch(assets[name]['browser_download_url'], METADATA_LIMIT)
        require(len(payloads[name]) == assets[name]['size']
                and hashlib.sha256(payloads[name]).hexdigest() == inventory[name],
                'Public release metadata differs from the signed inventory')
    release = json_document(payloads['RELEASE.json'])
    require(isinstance(release, dict) and release.get('version') == version,
            'Signed release version differs from the website version')
    signature = {'type': 'sigstore-keyless', 'identity': identity, 'issuer': ISSUER,
                 'inventory': 'SHA256SUMS', 'bundle': 'SHA256SUMS.sigstore.json'}
    require(release.get('signature') == signature, 'Signed release identity differs from its verifier')
    commit = release.get('commit')
    require(isinstance(commit, str) and re.fullmatch(r'[a-f0-9]{40}', commit),
            'Signed release source commit is invalid')
    api = f'https://api.github.com/repos/{REPOSITORY}/git/'
    reference = json_document(fetch(api + 'ref/tags/' + tag, METADATA_LIMIT))
    require(isinstance(reference, dict) and isinstance(reference.get('object'), dict),
            'Public release tag reference has an invalid shape')
    obj = reference['object']
    require(reference.get('ref') == 'refs/tags/' + tag and obj.get('type') == 'tag'
            and isinstance(obj.get('sha'), str) and re.fullmatch(r'[a-f0-9]{40}', obj['sha']),
            'Public release must have its exact annotated tag')
    annotated = json_document(fetch(api + 'tags/' + obj['sha'], METADATA_LIMIT))
    require(isinstance(annotated, dict) and isinstance(annotated.get('object'), dict),
            'Public annotated release tag has an invalid shape')
    target = annotated['object']
    require(annotated.get('tag') == tag and target.get('type') == 'commit'
            and target.get('sha') == commit
            and target.get('url') == f'https://api.github.com/repos/{REPOSITORY}/git/commits/{commit}',
        'Public release tag does not resolve to its signed source commit')
    images = checked_images(payloads['IMAGE-DIGESTS.env'])
    require(release.get('images') == images, 'Signed image manifests disagree')
    for image in images.values():
        verify(['verify', '--certificate-identity', identity,
                '--certificate-oidc-issuer', ISSUER, image], directory)
    return {'ready': True, 'version': version, 'release_source_commit': commit,
            'annotated_tag': obj['sha'], 'certificate_identity': identity,
            'oidc_issuer': ISSUER, 'inventory_sha256': hashlib.sha256(payloads['SHA256SUMS']).hexdigest(),
            'signed_payload_count': len(inventory), 'images': images,
            'inventory_and_image_signatures_verified': True}


def main():
    require(len(sys.argv) == 3, 'Expected release metadata path and website version')
    path = Path(sys.argv[1])
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= RELEASE_LIMIT,
            'Public release metadata file is invalid or oversized')
    metadata = json_document(path.read_bytes())
    with tempfile.TemporaryDirectory(prefix='vectory-site-release-', dir=os.environ.get('RUNNER_TEMP')) as temporary:
        result = verify_release(metadata, sys.argv[2], Path(temporary).resolve())
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError):
        print('Public release authentication failed; website deployment refused.', file=sys.stderr)
        raise SystemExit(1) from None
