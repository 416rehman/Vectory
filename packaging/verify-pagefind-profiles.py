#!/usr/bin/env python3
"""Verify pinned Pagefind native-package/WASM profiles.

--check is offline and validates publisher/source/lock metadata. --download
also retrieves each locked native package and published provenance, then checks
the exact compressed and decoded WASM members embedded in its binary. Foreign
native binaries are read as data, never executed.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
PROFILE_PATH = ROOT / 'packaging/notices/pagefind-wasm-profiles.json'
COMMIT = 'a2e9f40ef326f9a7926247695df25981a6f3ef4b'
KEYS = {'darwin-arm64', 'darwin-x64', 'freebsd-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def published_source_commit(document):
    commits = set()
    def walk(value):
        if isinstance(value, dict):
            if isinstance(value.get('payload'), str):
                statement = json.loads(base64.b64decode(value['payload']))
                for dependency in statement.get('predicate', {}).get('buildDefinition', {}).get('resolvedDependencies', []):
                    if dependency.get('uri', '').startswith('git+https://github.com/Pagefind/pagefind@'):
                        commits.add(dependency['digest']['gitCommit'])
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
    walk(document)
    if commits != {COMMIT}:
        raise ValueError('Published native-package source commit does not match corresponding source')
    return COMMIT


def get(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Vectory-Pagefind-profile-verifier'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024:
        raise ValueError('Native package exceeds size bound')
    return data


def check_native_archive(profile, data):
    package = profile['native_package']
    algorithm, digest = package['integrity'].split('-', 1)
    if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(data).digest()).decode('ascii') != digest or sha(data) != package['sha256'] or len(data) != package['bytes']:
        raise ValueError('Native package archive integrity differs from pinned profile')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        entry = archive.getmember('package/' + package['binary'])
        if not entry.isfile() or entry.size > 64 * 1024 * 1024:
            raise ValueError('Native binary entry invalid')
        binary = archive.extractfile(entry).read()
    if sha(binary) != package['binary_sha256']:
        raise ValueError('Native binary digest differs from pinned profile')
    for record in profile['wasm']:
        offset = record['native_binary_offset']
        compressed = binary[offset:offset + record['bytes']]
        if len(compressed) != record['bytes'] or sha(compressed) != record['sha256']:
            raise ValueError('Embedded compressed WASM differs from native profile')
        raw = zlib.decompress(compressed, wbits=31)
        if not raw.startswith(b'pagefind_dcd\0asm'):
            raise ValueError('Decoded Pagefind WASM header invalid')
        module = raw[len(b'pagefind_dcd'):]
        if sha(raw) != record['uncompressed_sha256'] or len(raw) != record['uncompressed_bytes'] or sha(module) != record['decoded_wasm_sha256'] or len(module) != record['decoded_wasm_bytes']:
            raise ValueError('Decoded WASM differs from native profile')


def verify(download=False, cache=None):
    profiles = json.loads(PROFILE_PATH.read_bytes())['profiles']
    if set(profiles) != KEYS:
        raise ValueError('Native platform profile set changed; verify upstream inputs first')
    lock = json.loads((ROOT / 'help-center/package-lock.json').read_bytes())['packages']
    for key, profile in profiles.items():
        native = profile['native_package']
        package = lock['node_modules/' + native['name']]
        if native['version'] != '1.5.2' or native['version'] != package['version'] or native['integrity'] != package['integrity'] or native['url'] != package['resolved'] or native['upstream_commit'] != COMMIT:
            raise ValueError('Locked native package/source differs from profile')
        if {record['filename'] for record in profile['wasm']} != {'wasm.en.pagefind', 'wasm.unknown.pagefind'} or len(profile['wasm']) != 2:
            raise ValueError('Native profile WASM pair invalid')
        if not download:
            continue
        path = cache / (key + '.tgz')
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(get(native['url']))
        check_native_archive(profile, path.read_bytes())
        provenance = get(native['published_provenance_url'])
        if sha(provenance) != native['published_provenance_sha256']:
            raise ValueError('Published provenance document changed; review source mapping')
        published_source_commit(json.loads(provenance))
    return profiles


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--cache', type=Path, default=ROOT / '.local/pagefind-native-profiles')
    args = parser.parse_args()
    if args.check and args.download:
        parser.error('--check is offline')
    profiles = verify(args.download, args.cache)
    print(f'Verified {len(profiles)} pinned native Pagefind profiles' + (' including exact archive/provenance/WASM bytes' if args.download else ' against lock/source metadata'))


if __name__ == '__main__':
    main()
