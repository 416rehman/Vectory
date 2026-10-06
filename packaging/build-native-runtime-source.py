#!/usr/bin/env python3
"""Retain exact authenticated Debian source packages for copied native runtimes.

APT authenticates source indices and downloaded files inside the exact source
images. This CI-only operation downloads corresponding source; it never builds
or installs it on a customer host. The optional source archive is a separate
release asset, authenticated by the same final Sigstore checksum inventory.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

MAX_BYTES = 2 * 1024 * 1024 * 1024


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def source_records(text, wanted):
    records = {}
    for stanza in text.split('\n\n'):
        fields, current = {}, None
        for line in stanza.splitlines():
            if line.startswith(' ') and current:
                fields[current] += '\n' + line.strip()
            elif ':' in line:
                current, value = line.split(':', 1)
                fields[current] = value.strip()
        key = (fields.get('Package'), fields.get('Version'))
        if key not in wanted:
            continue
        files = []
        for line in fields.get('Checksums-Sha256', '').splitlines():
            if not line:
                continue
            checksum, size, name = line.split()
            if not re.fullmatch(r'[0-9a-f]{64}', checksum) or not re.fullmatch(r'[A-Za-z0-9_.+~-]+', name):
                raise ValueError('Unsafe authenticated source-file record')
            size = int(size)
            if not 0 < size <= MAX_BYTES:
                raise ValueError('Corresponding source file exceeds its bound')
            files.append({'name': name, 'bytes': size, 'sha256': checksum})
        if not files or not any(item['name'].endswith('.dsc') for item in files):
            raise ValueError('Authenticated source metadata lacks its descriptor')
        if key in records and records[key] != files:
            raise ValueError('Conflicting source-package descriptions')
        records[key] = files
    if set(records) != wanted:
        raise ValueError('Exact native runtime corresponding sources are unavailable')
    return records


def fetch_authenticated_sources(arguments, destination):
    subprocess.run(arguments, check=True, timeout=600, stdout=subprocess.DEVNULL)
    # CAP_CHOWN lets the helper return files to the host owner, but does not
    # permit container root to chmod the host-owned mount. Only its host owner
    # sets the final mode after verified downloads return to their host owner.
    destination.chmod(0o755)


def build(provenance_path, out):
    proof = json.loads(provenance_path.read_text())
    version = proof['version']
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('Native source version must be stable')
    prefix = f'vectory-{version}-native-runtime-source'
    with tempfile.TemporaryDirectory(prefix='vectory-native-source-') as temporary:
        root = Path(temporary) / prefix
        root.mkdir()
        packages = []
        for role in ('server', 'validator'):
            wanted = {(item['source_package'], item['source_version']) for item in proof['runtime_packages'] if item['image'] == role}
            if not wanted or any(not re.fullmatch(r'[a-z0-9+.-]+', name) or not re.fullmatch(r'[A-Za-z0-9:_.+~_-]+', release) for name, release in wanted):
                raise ValueError('Invalid native runtime source-package identity')
            destination = root / role
            destination.mkdir()
            # Only this empty directory is mounted; its private 0700 ancestor
            # keeps other host users out. Container root has no DAC override.
            destination.chmod(0o777)
            image = proof['images'][role]['execution_id']
            if (not re.fullmatch(r'sha256:[a-f0-9]{64}', image)
                    or not re.fullmatch(r'sha256:[a-f0-9]{64}', proof['images'][role]['config_id'])
                    or (proof['images'][role].get('os'), proof['images'][role].get('architecture')) != ('linux', 'amd64')):
                raise ValueError('Corresponding source must be fetched inside its exact image')
            script = '''set -eu
for f in /etc/apt/sources.list.d/*.sources; do
  if [ -f "$f" ]; then sed -i 's/^Types: deb$/Types: deb deb-src/' "$f"; fi
done
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
  if [ -f "$f" ]; then sed -n 's/^deb /deb-src /p' "$f" >> /etc/apt/sources.list.d/vectory-corresponding-source.list; fi
done
apt-get -o APT::Sandbox::User=root -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false update >/dev/null
cd /out
: > SOURCE-INDEX.txt
for specification in "$@"; do
  apt-get -o APT::Sandbox::User=root -o APT::Get::AllowUnauthenticated=false source --download-only "$specification" >/dev/null
  apt-cache showsrc --only-source "${specification%%=*}" >> SOURCE-INDEX.txt
done
mkdir metadata
for f in /var/lib/apt/lists/*InRelease /var/lib/apt/lists/*Release /var/lib/apt/lists/*Release.gpg; do
  if [ -f "$f" ]; then cp "$f" metadata/; fi
done
cp /usr/share/keyrings/debian-archive-keyring.gpg metadata/
chown -R "$VECTORY_SOURCE_UID:$VECTORY_SOURCE_GID" /out
'''
            fetch_authenticated_sources(['docker', 'run', '--platform', 'linux/amd64', '--pull', 'never', '--rm', '--user', '0:0', '--cap-drop', 'ALL',
                '--cap-add', 'CHOWN', '--env', f'VECTORY_SOURCE_UID={os.getuid()}', '--env', f'VECTORY_SOURCE_GID={os.getgid()}',
                '--security-opt', 'no-new-privileges:true', '--memory', '768m', '--pids-limit', '64',
                '--mount', f'type=bind,src={destination.resolve()},dst=/out', '--entrypoint', '/bin/sh',
                image, '-c', script, 'vectory-source-fetch', *(name + '=' + release for name, release in sorted(wanted))], destination)
            records = source_records((destination / 'SOURCE-INDEX.txt').read_text(), wanted)
            allowed = {'SOURCE-INDEX.txt', 'metadata'}
            for key, files in records.items():
                for item in files:
                    allowed.add(item['name'])
                    path = destination / item['name']
                    if path.is_symlink() or not path.is_file() or path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
                        raise ValueError('Downloaded source differs from authenticated source index')
                packages.append({'image': role, 'source_package': key[0], 'source_version': key[1], 'files': files})
            if {path.name for path in destination.iterdir()} != allowed:
                raise ValueError('Corresponding source directory contains unexpected files')
        manifest = {'schema': 1, 'version': version, 'source_commit': proof['source_commit'],
            'images': proof['images'], 'packages': packages,
            'authentication': 'APT required authenticated Debian repository indices and source-file hashes; retained InRelease/Release signatures and Debian archive keyring accompany the exact downloaded descriptors and source archives.'}
        files, total = [], 0
        for path in sorted(root.rglob('*')):
            if path.is_dir():
                continue
            if path.is_symlink() or not path.is_file():
                raise ValueError('Source archive contains a link or nonregular member')
            relative = path.relative_to(root).as_posix()
            if not re.fullmatch(r'[A-Za-z0-9._+~@/-]+', relative):
                raise ValueError('Unsafe corresponding-source filename')
            total += path.stat().st_size
            if total > MAX_BYTES:
                raise ValueError('Corresponding sources exceed the expanded size bound')
            files.append({'path': relative, 'bytes': path.stat().st_size, 'sha256': digest(path)})
        manifest['files'] = files
        metadata = json.dumps(manifest, indent=2, sort_keys=True) + '\n'
        (root / 'SOURCE-MANIFEST.json').write_text(metadata)
        out.mkdir(parents=True, exist_ok=True)
        (out / 'native-runtime-source.json').write_text(metadata)
        destination = out / (prefix + '.tar.gz')
        with destination.open('wb') as target, gzip.GzipFile(filename='', mode='wb', fileobj=target, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for path in sorted(root.rglob('*')):
                    if path.is_dir():
                        continue
                    member = tarfile.TarInfo(prefix + '/' + path.relative_to(root).as_posix())
                    member.size, member.mode, member.uid, member.gid, member.mtime = path.stat().st_size, 0o644, 0, 0, 0
                    with path.open('rb') as source:
                        archive.addfile(member, source)
        return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provenance', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(build(args.provenance, args.out))
