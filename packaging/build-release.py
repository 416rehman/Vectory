#!/usr/bin/env python3
"""Build unsigned development release artifacts. Native validation is a separate gate."""
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
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGETS = [('linux', 'amd64'), ('linux', 'arm64'), ('darwin', 'amd64'), ('darwin', 'arm64'), ('windows', 'amd64')]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive(path, members):
    if path.suffix == '.zip':
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as out:
            for name, data, mode in members:
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.external_attr = mode << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                out.writestr(info, data)
    else:
        with path.open('wb') as file:
            with gzip.GzipFile(filename='', mode='wb', fileobj=file, mtime=0) as gz:
                with tarfile.open(mode='w', fileobj=gz) as out:
                    for name, data, mode in members:
                        info = tarfile.TarInfo(name)
                        info.size, info.mode, info.mtime = len(data), mode, 0
                        info.uid = info.gid = 0
                        out.addfile(info, io.BytesIO(data))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default='0.1.0-dev')
    parser.add_argument('--out', type=Path, default=ROOT / 'artifacts/releases')
    parser.add_argument('--target', choices=[f'{o}/{a}' for o, a in TARGETS], action='append')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', args.version):
        parser.error('version must be a safe semantic version')
    source = (ROOT / 'agent/internal/agent/types.go').read_text(encoding='utf-8')
    version_match = re.search(r'^const Version = "([^"]+)"$', source, re.MULTILINE)
    if version_match is None or args.version != version_match.group(1):
        parser.error('package version must match the agent source Version; refusing misleading metadata')
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    catalog = []
    for goos, goarch in TARGETS:
        if args.target and f'{goos}/{goarch}' not in args.target:
            continue
        name = f'vectory-{args.version}-{goos}-{goarch}'
        binary_name = name + ('.exe' if goos == 'windows' else '')
        binary = out / binary_name
        env = {**os.environ, 'CGO_ENABLED': '0', 'GOOS': goos, 'GOARCH': goarch, 'GOAMD64': 'v1', 'GOTOOLCHAIN': 'go1.26.8'}
        subprocess.run(['go', 'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', str(binary), './cmd/vectory'], cwd=ROOT / 'agent', env=env, check=True)
        catalog.append({'name': binary.name, 'os': goos, 'arch': goarch, 'version': args.version, 'sha256': sha(binary), 'size': binary.stat().st_size, 'url': '/api/v1/releases/' + binary.name, 'signed': False})
        members = [('vectory.exe' if goos == 'windows' else 'vectory', binary.read_bytes(), 0o755),
                   ('RELEASE-STATUS.txt', b'UNSIGNED DEVELOPMENT BUILD. Native OS/service acceptance and signing are separate gates. No enrollment secrets included.\n', 0o644)]
        for rel in ('LICENSE', 'NOTICE', 'docs/AGENT-INSTALL.md', 'docs/COMPATIBILITY.md'):
            file = ROOT / rel
            if file.exists():
                members.append((rel, file.read_bytes(), 0o644))
        service = {'linux': 'packaging/systemd/vectory.service', 'darwin': 'packaging/launchd/com.vectory.agent.plist', 'windows': 'packaging/windows/install-service.ps1'}[goos]
        members.append((service, (ROOT / service).read_bytes(), 0o644))
        archive(out / (name + ('.zip' if goos == 'windows' else '.tar.gz')), members)
    (out / 'catalog.json').write_text(json.dumps(catalog, indent=2) + '\n', encoding='utf-8')
    artifacts = sorted(p for p in out.iterdir() if p.is_file() and p.name != 'SHA256SUMS' and not p.name.endswith(('.sig', '.bundle')))
    (out / 'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in artifacts), encoding='utf-8')
    print(f'Built {len(catalog)} unsigned target binaries and archives in {out}')


if __name__ == '__main__':
    main()
