#!/usr/bin/env python3
"""Create the small deterministic starter for the prebuilt Linux local preview."""
import argparse
import gzip
import hashlib
import io
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def build(out, kind='preview'):
    source = (ROOT / 'agent/internal/agent/types.go').read_text(encoding='utf-8')
    match = re.search(r'^const Version = "([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)"$', source, re.MULTILINE)
    if match is None:
        raise ValueError('agent source has no safe release version')
    version = match.group(1)
    if kind not in ('preview', 'server'):
        raise ValueError('unknown starter kind')
    prefix = f'vectory-{version}-{kind}-linux-amd64'
    members = {
        'start.sh': ((ROOT / f'deploy/start-{kind}.sh').read_bytes(), 0o755),
        'release-images.sh': ((ROOT / 'deploy/release-images.sh').read_bytes(), 0o644),
        'compose.yaml': ((ROOT / ('deploy/compose.preview.yaml' if kind == 'preview' else 'deploy/compose.release.yaml')).read_bytes(), 0o644),
        'README.md': ((ROOT / f'deploy/{kind.upper()}-README.md').read_bytes(), 0o644),
        'LICENSE': ((ROOT / 'LICENSE').read_bytes(), 0o644),
        'NOTICE': ((ROOT / 'NOTICE').read_bytes(), 0o644),
        'VERSION': ((version + '\n').encode(), 0o644),
    }
    if kind == 'server':
        members['Caddyfile'] = ((ROOT / 'deploy/Caddyfile').read_bytes(), 0o644)
        members['.env.example'] = ((ROOT / 'deploy/.env.release.example').read_bytes(), 0o644)
    members['SHA256SUMS'] = (''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n'
        for name, (data, _) in sorted(members.items())).encode(), 0o644)
    out.mkdir(parents=True, exist_ok=True)
    destination = out / f'{prefix}.tar.gz'
    with destination.open('wb') as file:
        with gzip.GzipFile(filename='', mode='wb', fileobj=file, mtime=0) as compressed:
            with tarfile.open(mode='w', fileobj=compressed, format=tarfile.USTAR_FORMAT) as archive:
                for name, (data, mode) in sorted(members.items()):
                    item = tarfile.TarInfo(f'{prefix}/{name}')
                    item.size, item.mode, item.mtime = len(data), mode, 0
                    item.uid = item.gid = 0
                    archive.addfile(item, io.BytesIO(data))
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'artifacts/releases')
    args = parser.parse_args()
    for kind in ('preview', 'server'):
        print(build(args.out, kind))
