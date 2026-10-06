#!/usr/bin/env python3
"""Package Linux systemd installation from the exact prebuilt candidate images.

Build-time Docker extracts immutable image bytes. No compiler or container
engine is needed on the native installation host. Only regular bounded files
enter the deterministic archive; dependencies and their image origins are
recorded explicitly. This does not by itself prove isolation or release signing.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
COSIGN_URL = 'https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64'
COSIGN_SHA256 = '4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71'
COSIGN_SBOM = 'cosign-linux-amd64_3.1.3_linux_amd64.sbom.json'
COSIGN_SBOM_SHA256 = 'd4a7d1a4f3cb5f4f87a01e81e511abb5f6f99c2e2bb7b929bde608a1ccfd14c3'
PROXY_IMAGE = 'caddy:2.11.7-alpine@sha256:d76116d819d5162f464b0f2cd09bd28c568a86148c7bc539ce17c33eb22d8bbb'
PROXY_CONFIG = 'sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77'
MAX_FILE = 256 * 1024 * 1024
MAX_PAYLOAD = 2 * 1024 * 1024 * 1024
MAX_FILES = 20000
RUNTIME_PATH = re.compile(r'/(?:usr/)?lib(?:64|/x86_64-linux-gnu)/[A-Za-z0-9_.+-]+$')


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def command(*args, timeout=120):
    result = subprocess.run(args, check=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if len(result.stdout) + len(result.stderr) > 8 * 1024 * 1024:
        raise ValueError('Build command output exceeded its bound')
    return result.stdout.decode('utf-8', errors='strict').strip()


def image_run(image, executable, *args):
    return command('docker', 'run', '--platform', 'linux/amd64', '--pull', 'never', '--rm', '--network', 'none', '--read-only',
                   '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                   '--memory', '256m', '--pids-limit', '32', '--entrypoint',
                   executable, image, *args)


def image_identity(image, user=None, archive_path=None, expected_tag=None):
    records = json.loads(command('docker', 'image', 'inspect', image))
    if len(records) != 1:
        raise ValueError('Native kit needs one exact image identity')
    item = records[0]
    if (item.get('Architecture'), item.get('Os')) != ('amd64', 'linux'):
        raise ValueError('Native server kit supports only Linux amd64')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', item.get('Id', '')):
        raise ValueError('Source image has no immutable execution identity')
    if user and item.get('Config', {}).get('User') != user:
        raise ValueError('Source candidate execution user differs from its contract')
    execution_id = item['Id']
    spec = importlib.util.spec_from_file_location('native_image_archive_verifier', ROOT / 'packaging/verify-release.py')
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    if archive_path is not None:
        saved = verifier.required_image(archive_path, expected_tag, identity=True)
    else:
        # Export the immutable inspected execution ID, never a tag that can
        # change between inspection and extraction. Docker 29 may identify an
        # image by its OCI index/manifest rather than by its config digest.
        with tempfile.TemporaryDirectory(prefix='vectory-native-image-identity-') as temporary:
            archive = Path(temporary) / 'source-image.tar'
            command('docker', 'image', 'save', '--output', str(archive), execution_id, timeout=180)
            saved = verifier.required_image(archive, identity=True, uncompressed=True)
    configuration = saved['configuration']
    execution_user = item.get('Config', {}).get('User', '')
    configuration_user = configuration['config'].get('User', '')
    if (execution_id not in saved['execution_ids']
            or item.get('RootFS', {}).get('Type') != 'layers'
            or item['RootFS'].get('Layers') != configuration['rootfs']['diff_ids']
            # Classic Docker fills the omitted default User with "", while
            # containerd preserves its omission. Explicit execution users must
            # still match exactly in both independent configuration records.
            or not isinstance(execution_user, str) or not isinstance(configuration_user, str)
            or execution_user != configuration_user
            or (user and configuration['config'].get('User') != user)):
        raise ValueError('Source execution image differs from its exact saved configuration')
    return {'reference': image, 'config_id': saved['config_id'], 'execution_id': execution_id,
            'architecture': item['Architecture'], 'os': item['Os']}


@contextmanager
def stopped_image(image):
    container = command('docker', 'create', '--platform', 'linux/amd64', '--pull', 'never', '--network', 'none', image)
    if not re.fullmatch(r'[0-9a-f]{64}', container):
        raise ValueError('Docker did not return a unique owned build container')
    try:
        yield container
    finally:
        command('docker', 'rm', container)


def safe_files(root):
    files, total = [], 0
    for path in sorted(root.rglob('*')):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise ValueError('Native payload contains a link or nonregular file')
        relative = path.relative_to(root).as_posix()
        if (PurePosixPath(relative).is_absolute() or '..' in PurePosixPath(relative).parts
                or not re.fullmatch(r'[A-Za-z0-9._+@/-]+', relative) or len(relative.encode()) > 240):
            raise ValueError('Unsafe native payload filename')
        size = path.stat().st_size
        total += size
        if not 0 < size <= MAX_FILE or total > MAX_PAYLOAD or len(files) >= MAX_FILES:
            raise ValueError('Native payload exceeds bounded file inventory')
        files.append(path)
    return files


def elf64(path):
    with path.open('rb') as source:
        header = source.read(64)
    if (len(header) != 64 or header[:6] != b'\x7fELF\x02\x01'
            or int.from_bytes(header[18:20], 'little') != 62):
        raise ValueError(f'Native executable is not Linux ELF64 amd64: {path.name}')


def dependency_paths(output):
    paths = set()
    for line in output.splitlines():
        if 'not found' in line or 'not a dynamic executable' in line:
            raise ValueError('A required native runtime dependency is unavailable')
        match = re.search(r'(?:=>\s*)?(/\S+)\s+\(0x[0-9a-f]+\)', line)
        if match:
            path = match.group(1)
            if not RUNTIME_PATH.fullmatch(path):
                raise ValueError('Native runtime dependency lies outside fixed library directories')
            paths.add(path)
    if not paths or '/lib64/ld-linux-x86-64.so.2' not in paths:
        raise ValueError('Native ELF runtime has no reviewed x86-64 loader')
    return paths


def build(out, server_image, validator_image, sbom_dir, payload_dir=None):
    version = re.search(r'^const Version = "([0-9]+\.[0-9]+\.[0-9]+)"$',
                        (ROOT / 'agent/internal/agent/types.go').read_text(), re.M).group(1)
    identities = {'server': image_identity(server_image, '10001:10001',
                       sbom_dir / 'vectory-server-image.tar.gz', 'vectory-server:candidate'),
                  'validator': image_identity(validator_image, '10002:10002',
                       sbom_dir / 'vectory-validator-image.tar.gz', 'vectory-validator:candidate'),
                  'proxy': image_identity(PROXY_IMAGE)}
    if (identities['proxy']['config_id'] != PROXY_CONFIG or identities['proxy']['execution_id'] not in
            (PROXY_CONFIG, PROXY_IMAGE.rsplit('@', 1)[1])):
        raise ValueError('Proxy executable source differs from the reviewed platform configuration')
    prefix = f'vectory-{version}-server-native-linux-amd64'
    out.mkdir(parents=True, exist_ok=True)
    if payload_dir and payload_dir.exists():
        raise ValueError('Retained native payload destination must not already exist')
    with tempfile.TemporaryDirectory(prefix='vectory-native-build-') as temporary:
        root = Path(temporary) / prefix
        root.mkdir()
        origins, os_packages = {}, {}

        def copy_image(container, role, source, destination):
            target = root / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            command('docker', 'cp', '-L', container + ':' + source, str(target))
            if target.is_dir():
                for file in safe_files(target):
                    origins[file.relative_to(root).as_posix()] = {'image': role, 'path':
                        source.rstrip('/.') + '/' + file.relative_to(target).as_posix()}
            elif target.is_file() and not target.is_symlink():
                origins[destination] = {'image': role, 'path': source}
            else:
                raise ValueError('Image copy produced no regular payload')

        for role, image, binaries in (
            ('server', identities['server']['execution_id'], ['/usr/local/bin/vectory-server', '/usr/local/bin/vectory-admin']),
            ('validator', identities['validator']['execution_id'], ['/usr/local/bin/vector-validator', '/usr/bin/vector']),
        ):
            with stopped_image(image) as container:
                closure = set()
                for binary in binaries:
                    target = role + '-root' + binary
                    copy_image(container, role, binary, target)
                    elf64(root / target)
                    (root / target).chmod(0o755)
                    closure |= dependency_paths(image_run(image, '/usr/bin/ldd', binary))
                packages = set()
                for library in sorted(closure):
                    target = role + '-root' + library
                    copy_image(container, role, library, target)
                    elf64(root / target)
                    (root / target).chmod(0o755)
                    canonical = image_run(image, '/usr/bin/readlink', '-f', library)
                    alternatives = [canonical, canonical.replace('/usr/lib/', '/lib/', 1), library]
                    owner = None
                    for path in dict.fromkeys(alternatives):
                        try:
                            owner = image_run(image, '/usr/bin/dpkg-query', '-S', path).split(': ', 1)[0]
                            break
                        except subprocess.CalledProcessError:
                            pass
                    if not owner or not re.fullmatch(r'[a-z0-9+.-]+(?::amd64)?', owner):
                        raise ValueError('Runtime library has no unambiguous installed Debian package')
                    packages.add(owner)
                for package in sorted(packages):
                    record = image_run(image, '/usr/bin/dpkg-query', '-W',
                        '--showformat=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}', package).split('\t')
                    if len(record) != 4 or not all(record):
                        raise ValueError('Runtime dependency lacks exact source-package identity')
                    name, release, source_name, source_version = record
                    os_packages[role + ':' + name] = {'package': name, 'version': release,
                        'source_package': source_name, 'source_version': source_version,
                        'image': role, 'source_archive': 'Debian source package ' + source_name + '=' + source_version}
                    path = '/usr/share/doc/' + name.split(':')[0] + '/copyright'
                    copy_image(container, role, path, role + '-root' + path)
                copy_image(container, role, '/usr/share/common-licenses', role + '-root/usr/share/common-licenses')
                copy_image(container, role, '/etc/os-release', role + '-root/etc/os-release')
                if role == 'server':
                    for source, target in [('/app/dashboard', 'dashboard'), ('/app/agent-releases', 'agents'),
                        ('/app/operations/vectory-local-pki', 'bin/vectory-local-pki'),
                        ('/app/operations/vectory-server-pki', 'bin/vectory-server-pki')]:
                        copy_image(container, role, source, target)
                else:
                    copy_image(container, role, '/usr/share/vector', 'validator-root/usr/share/vector')
        with stopped_image(identities['proxy']['execution_id']) as container:
            copy_image(container, 'proxy', '/usr/bin/caddy', 'bin/caddy')
        for name in ('caddy', 'vectory-local-pki', 'vectory-server-pki'):
            elf64(root / 'bin' / name)
            (root / 'bin' / name).chmod(0o755)
        verifier = root / 'bin/cosign'
        verifier.parent.mkdir(exist_ok=True)
        with urllib.request.urlopen(COSIGN_URL, timeout=60) as source, verifier.open('wb') as target:
            shutil.copyfileobj(source, target, 1024 * 1024)
        if digest(verifier) != COSIGN_SHA256:
            raise ValueError('Official native Cosign binary differs from its reviewed immutable SHA-256')
        elf64(verifier)
        verifier.chmod(0o755)
        origins['bin/cosign'] = {'url': COSIGN_URL, 'sha256': COSIGN_SHA256}
        cosign_sbom = root / 'sbom' / COSIGN_SBOM
        cosign_sbom.parent.mkdir(exist_ok=True)
        sbom_url = COSIGN_URL.rsplit('/', 1)[0] + '/' + COSIGN_SBOM
        with urllib.request.urlopen(sbom_url, timeout=60) as source, cosign_sbom.open('wb') as target:
            shutil.copyfileobj(source, target, 1024 * 1024)
        if digest(cosign_sbom) != COSIGN_SBOM_SHA256:
            raise ValueError('Official Cosign SBOM differs from its reviewed SHA-256')
        origins['sbom/' + COSIGN_SBOM] = {'url': sbom_url, 'sha256': COSIGN_SBOM_SHA256}
        cosign_license = root / 'legal/cosign/LICENSE'
        cosign_license.parent.mkdir(parents=True)
        license_url = 'https://raw.githubusercontent.com/sigstore/cosign/v3.1.3/LICENSE'
        with urllib.request.urlopen(license_url, timeout=60) as source:
            license_bytes = source.read(1024 * 1024 + 1)
        if len(license_bytes) > 1024 * 1024 or b'Apache License' not in license_bytes:
            raise ValueError('Official Cosign license is unavailable')
        cosign_license.write_bytes(license_bytes)
        origins['legal/cosign/LICENSE'] = {'url': license_url}
        for path in (ROOT / 'deploy/native').rglob('*'):
            if path.is_file() and not path.is_symlink():
                relative = path.relative_to(ROOT).as_posix()
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
                target.chmod(0o755 if target.suffix == '.sh' else 0o644)
                origins[relative] = {'repository_path': relative}
        for name in ('LICENSE', 'NOTICE'):
            shutil.copyfile(ROOT / name, root / name)
            origins[name] = {'repository_path': name}
        (root / 'VERSION').write_text(version + '\n')
        launcher = root / 'start.sh'
        launcher.write_text('#!/usr/bin/env bash\nset -euo pipefail\nhere=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)\nexec "$here/deploy/native/start.sh" "$@"\n')
        launcher.chmod(0o755)
        admin_launcher = root / 'admin.sh'
        admin_launcher.write_text('#!/usr/bin/env bash\nset -euo pipefail\nhere=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)\nexec "$here/deploy/native/admin.sh" "$@"\n')
        admin_launcher.chmod(0o755)
        shutil.copyfile(root / 'deploy/native/README.md', root / 'README.md')
        origins['README.md'] = {'repository_path': 'deploy/native/README.md'}
        for component in ('server', 'validator'):
            name = f'vectory-{component}-image.spdx.json'
            target = root / 'sbom' / name
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(sbom_dir / name, target)
            origins['sbom/' + name] = {'candidate_asset': name}
        files = safe_files(root)
        inventory = [{'path': path.relative_to(root).as_posix(), 'sha256': digest(path),
            'bytes': path.stat().st_size, 'mode': '0755' if path.stat().st_mode & 0o111 else '0644',
            'origin': origins.get(path.relative_to(root).as_posix(), {'generated': True})} for path in files]
        provenance = {'schema': 1, 'version': version, 'platform': 'linux-amd64-systemd',
            'source_commit': os.environ.get('GITHUB_SHA') or command('git', 'rev-parse', 'HEAD'),
            'images': identities, 'runtime_packages': list(os_packages.values()), 'files': inventory,
            'scope': 'Extracted prebuilt candidate image bytes. Isolation and actual native startup require the separate native smoke gate. Release authentication is provided by the final tagged SHA256SUMS Sigstore bundle.'}
        metadata = json.dumps(provenance, indent=2, sort_keys=True) + '\n'
        (root / 'NATIVE-PROVENANCE.json').write_text(metadata)
        (out / 'native-kit-provenance.json').write_text(metadata)
        for installer in ('install.sh', 'install-desktop.sh', 'install.ps1', 'install-native.sh'):
            shutil.copyfile(ROOT / 'deploy' / installer, out / installer)
        packages = [{
            'SPDXID': 'SPDXRef-NativeKit', 'name': 'Vectory native Linux server kit',
            'versionInfo': version, 'downloadLocation': 'https://github.com/416rehman/Vectory/releases/tag/v' + version,
            'filesAnalyzed': False, 'licenseConcluded': 'NOASSERTION', 'licenseDeclared': 'NOASSERTION',
            'copyrightText': 'NOASSERTION',
        }]
        for component, release, license_id in [('Vectory', version, 'Apache-2.0'),
            ('Vector', '0.58.0', 'MPL-2.0'), ('Caddy', '2.11.7', 'Apache-2.0'), ('Cosign', '3.1.3', 'Apache-2.0')]:
            packages.append({'SPDXID': 'SPDXRef-' + component, 'name': component, 'versionInfo': release,
                'downloadLocation': 'NOASSERTION', 'filesAnalyzed': False,
                'licenseConcluded': 'NOASSERTION', 'licenseDeclared': license_id, 'copyrightText': 'NOASSERTION'})
        for key, package in sorted(os_packages.items()):
            packages.append({'SPDXID': 'SPDXRef-OS-' + hashlib.sha256(key.encode()).hexdigest()[:24],
                'name': package['package'], 'versionInfo': package['version'], 'downloadLocation': 'NOASSERTION',
                'filesAnalyzed': False, 'licenseConcluded': 'NOASSERTION', 'licenseDeclared': 'NOASSERTION',
                'copyrightText': 'NOASSERTION', 'sourceInfo': package['source_archive']})
        created = datetime.fromisoformat(command('git', 'show', '-s', '--format=%cI', 'HEAD')).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        file_records = [{'SPDXID': 'SPDXRef-File-' + hashlib.sha256(record['path'].encode()).hexdigest()[:24],
            'fileName': './' + record['path'], 'checksums': [{'algorithm': 'SHA256', 'checksumValue': record['sha256']}],
            'licenseConcluded': 'NOASSERTION', 'copyrightText': 'NOASSERTION'} for record in inventory]
        sbom = {'spdxVersion': 'SPDX-2.3', 'dataLicense': 'CC0-1.0', 'SPDXID': 'SPDXRef-DOCUMENT',
            'name': 'Vectory native payload inventory',
            'documentNamespace': 'https://spdx.org/spdxdocs/vectory-native-' + hashlib.sha256(metadata.encode()).hexdigest(),
            'creationInfo': {'created': created, 'creators': ['Tool: Vectory native image extractor 1']},
            'documentComment': 'Exact regular-file hashes and runtime package versions copied from candidate image identities in native-kit-provenance.json. Source-image SPDX documents are included in the kit. This is not license clearance, a vulnerability scan or isolation proof.',
            'packages': packages, 'files': file_records,
            'relationships': [{'spdxElementId': 'SPDXRef-DOCUMENT', 'relationshipType': 'DESCRIBES', 'relatedSpdxElement': 'SPDXRef-NativeKit'}]
                + [{'spdxElementId': 'SPDXRef-NativeKit', 'relationshipType': 'CONTAINS', 'relatedSpdxElement': item['SPDXID']} for item in packages[1:] + file_records]}
        (out / 'vectory-native.spdx.json').write_text(json.dumps(sbom, indent=2, sort_keys=True) + '\n')
        (root / 'SHA256SUMS').write_text(''.join(f'{digest(path)}  {path.relative_to(root).as_posix()}\n'
            for path in safe_files(root)), encoding='utf-8')
        archive_path = out / (prefix + '.tar.gz')
        with archive_path.open('wb') as target, gzip.GzipFile(filename='', mode='wb', fileobj=target, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for path in safe_files(root):
                    item = tarfile.TarInfo(prefix + '/' + path.relative_to(root).as_posix())
                    item.size = path.stat().st_size
                    item.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
                    item.mtime = item.uid = item.gid = 0
                    with path.open('rb') as source:
                        archive.addfile(item, source)
        if payload_dir:
            shutil.copytree(root, payload_dir)
        return archive_path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--sbom-dir', type=Path, required=True)
    parser.add_argument('--payload-dir', type=Path)
    parser.add_argument('--server-image', default='vectory-server:candidate')
    parser.add_argument('--validator-image', default='vectory-validator:candidate')
    args = parser.parse_args()
    print(build(args.out, args.server_image, args.validator_image, args.sbom_dir, args.payload_dir))
