#!/usr/bin/env python3
"""Package the pinned Pagefind WASM corresponding source without executing it.

--download fetches exact upstream inputs over HTTPS into an ignored cache.
--check verifies the checked-in archive, provenance, and shipped WASM hashes
without network access. Rebuilding search is optional developer work, never
a prerequisite for installing Vectory.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import tomllib
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'help-center/legal'
VERSION = '1.5.2'
COMMIT = 'a2e9f40ef326f9a7926247695df25981a6f3ef4b'
PREFIX = f'pagefind-{VERSION}-source'
ARCHIVE = PREFIX + '.tar.gz'
MANIFEST = PREFIX + '.json'
SOURCE_URL = f'https://github.com/Pagefind/pagefind/tree/{COMMIT}'
TREE_URL = f'https://codeload.github.com/Pagefind/pagefind/tar.gz/{COMMIT}'
SNOWBALL_COMMIT = '988b5ae3fff9db34cc978c8ddd3b84f83ef5ef58'
SNOWBALL_URL = f'https://codeload.github.com/snowballstem/snowball/tar.gz/{SNOWBALL_COMMIT}'
MAX_INPUT = 64 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
WASM_LOCK_SHA256 = 'd762f97d4dc284014c284f2b2147d0d29bb4add334df4bdc14eaf4e84201a5c3'
UI_LOCK_SHA256 = '278a71cacfa1a5e1dbd9365039f67f363fc5ae18b4c6aa897ace00ed8b8761ae'
PROFILES_PATH = ROOT / 'packaging/notices/pagefind-wasm-profiles.json'
WASM_PROFILES = json.loads(PROFILES_PATH.read_bytes())['profiles']

REBUILD = """Pagefind 1.5.2 compiled Help search: corresponding source

This archive accompanies the two precompiled Pagefind WASM search components
served by Vectory Help. Individual source files retain their original licenses.
pagefind_microjson 0.1.4 is GPL-3.0-only; its full text is also in COPYING.
The complete upstream Pagefind source tree and all 21 registry packages in its
WASM lockfile are included. The pagefind_web workspace package is the 22nd.
The matching Snowball 3.0.0 development-revision generator and preferred .sbl
algorithm sources accompany the generated Pagefind stem Rust source, with
their original BSD notice. This is an immutable revision after the 3.0.0 tag;
the tagged release itself did not regenerate the exact packaged Rust.
The five npm runtime packages embedded in the precompiled search UI are also
included in ui-vendor/, pinned to the upstream UI package-lock integrity.
SOURCE-MANIFEST.json records the exact HTTPS inputs and file hashes.

Upstream commit: a2e9f40ef326f9a7926247695df25981a6f3ef4b
Source: https://github.com/Pagefind/pagefind/tree/a2e9f40ef326f9a7926247695df25981a6f3ef4b

These instructions are optional for developers inspecting/modifying search.
Normal Vectory installation uses prebuilt kits and requires no compiler.

Compile the English and language-neutral Rust WASM modules

Use a Rust toolchain compatible with the pinned source and install its
wasm32-unknown-unknown target. Both commands below were verified in an isolated
Rust 1.94.0 container with network access disabled. A compiler/target is not
included. Registry sources are vendored;
Cargo runs offline after the compiler/target have been provisioned.

  cd upstream/pagefind_web
  cargo build --locked --offline --release --target wasm32-unknown-unknown --features en
  cp target/wasm32-unknown-unknown/release/pagefind_web.wasm ../../pagefind.en.wasm
  cargo build --locked --offline --release --target wasm32-unknown-unknown --no-default-features
  cp target/wasm32-unknown-unknown/release/pagefind_web.wasm ../../pagefind.unknown.wasm

The upstream release additionally applies wasm-bindgen and wasm-opt, then
compresses/packages the modules for Pagefind. The complete build scripts and
GitHub release workflow are in upstream/justfile, upstream/.github/workflows/
and upstream/.cargo/. Read those for its release packaging commands and tool
versions. Compiler/optimizer choices can change bytes. A successful source
build is not a claim of byte-for-byte equivalence to the upstream precompiled
artifacts whose hashes are separately recorded in Vectory's public manifest.

Regenerate the stem algorithms (optional)

The packaged stem crate already contains generated Rust, so the Cargo build
above does not require this step. To modify preferred algorithm definitions,
use the supplied Snowball 3.0.0 development source at snowball/ (immutable
commit 988b5ae3fff9db34cc978c8ddd3b84f83ef5ef58). Its algorithms/english.sbl and
compiler/runtime sources are included along with COPYING. A C compiler and
make build the Snowball generator; the upstream Pagefind regeneration helper
also uses Node.js. Run from the archive root:

  make -C snowball
  node upstream/pagefind_stem/build.js

The included generator was compiled with make/cc inside an isolated container
with network disabled. It regenerated English Rust byte-for-byte identical
to the checksum-pinned pagefind_stem crate, and its three Rust runtime files
also matched. Generated English Rust SHA-256:
e83bb65144434954728488c5bd9f796f23a7d6829609db5b4f1adaed5c924a90

Read upstream/pagefind_stem/build.js before regenerating and reviewing the
result. The separately checksum-pinned registry crate in vendor/ is the exact
published compile input; regenerating upstream/ does not overwrite vendor/.
To compile your regenerated stem instead, explicitly replace the vendored
crate and update Cargo's source checksums/lockfile as part of your changes.

This source is provided with the permissions in its respective license texts;
it is not a substitute for a legal assessment of a particular redistribution.
"""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name or not name:
        raise ValueError(f'Unsafe source member: {name}')
    return name


def fetch(url, path, allow_download, expected=None):
    if not path.exists():
        if not allow_download:
            raise ValueError(f'Missing source input cache {path.name}; use --download')
        request = urllib.request.Request(url, headers={'User-Agent': 'Vectory-corresponding-source-builder'})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise ValueError('Source input exceeds size bound')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    data = path.read_bytes()
    if expected and sha(data) != expected:
        raise ValueError(f'Source checksum mismatch: {path.name}')
    return data


def unpack(data, prefix):
    files, links = {}, []
    expanded = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            if member.name == prefix and member.isdir():
                continue
            if not member.name.startswith(prefix + '/'):
                raise ValueError('Unexpected archive source prefix')
            name = member.name[len(prefix) + 1:]
            if not name:
                continue
            safe_name(name)
            if member.isdir():
                continue
            if member.issym():
                links.append((name, member.linkname))
                continue
            if not member.isfile():
                raise ValueError('Unsupported source archive entry')
            expanded += member.size
            if expanded > MAX_EXPANDED or len(files) > 15000:
                raise ValueError('Source tree exceeds size/count bound')
            files[name] = archive.extractfile(member).read()
    # Dereference internal source symlinks to regular files for portable delivery.
    for name, target in links:
        path = PurePosixPath(name).parent / target
        parts = []
        for part in path.parts:
            if part == '..':
                if not parts:
                    raise ValueError('Source symlink escaped tree')
                parts.pop()
            elif part != '.':
                parts.append(part)
        resolved = '/'.join(parts)
        if resolved not in files:
            raise ValueError(f'Unresolved source symlink: {name}')
        files[name] = files[resolved]
    return files


def closure(lock):
    by_name = {}
    for package in lock['package']:
        by_name.setdefault(package['name'], []).append(package)
    queue, packages = ['pagefind_web'], {}
    while queue:
        parts = queue.pop().split()
        options = by_name[parts[0]]
        if len(parts) > 1:
            options = [p for p in options if p['version'] == parts[1]]
        if len(options) != 1:
            raise ValueError('Ambiguous locked Pagefind dependency')
        package = options[0]
        key = (package['name'], package['version'])
        if key in packages:
            continue
        packages[key] = package
        queue.extend(package.get('dependencies', []))
    if len(packages) != 22:
        raise ValueError('Unexpected pinned WASM graph size')
    return [packages[key] for key in sorted(packages)]


def build(cache, allow_download):
    tree = fetch(TREE_URL, cache / 'pagefind-upstream.tar.gz', allow_download)
    source = unpack(tree, 'pagefind-' + COMMIT)
    lock = tomllib.loads(source['pagefind_web/Cargo.lock'].decode('utf-8'))
    files = {'upstream/' + name: data for name, data in source.items()}
    inputs = []
    ui_inputs = []
    for package in closure(lock):
        name, version = package['name'], package['version']
        if not package.get('source'):
            inputs.append({'name': name, 'version': version, 'url': TREE_URL, 'sha256': sha(tree), 'upstream_commit': COMMIT, 'path': 'upstream/pagefind_web'})
            continue
        if not package['source'].startswith('registry+'):
            raise ValueError('Unrecognized dependency source')
        url = f'https://crates.io/api/v1/crates/{name}/{version}/download'
        data = fetch(url, cache / (name + '-' + version + '.crate'), allow_download, package['checksum'])
        package_files = unpack(data, name + '-' + version)
        dest = 'vendor/' + name + '-' + version
        files.update({dest + '/' + file: content for file, content in package_files.items()})
        checksums = {'files': {file: sha(content) for file, content in sorted(package_files.items())}, 'package': package['checksum']}
        files[dest + '/.cargo-checksum.json'] = (json.dumps(checksums, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
        inputs.append({'name': name, 'version': version, 'url': url, 'sha256': package['checksum'], 'path': dest})
    snowball = fetch(SNOWBALL_URL, cache / ('snowball-' + SNOWBALL_COMMIT + '.tar.gz'), allow_download)
    snowball_source = unpack(snowball, 'snowball-' + SNOWBALL_COMMIT)
    files.update({'snowball/' + name: data for name, data in snowball_source.items()})
    inputs.append({'name': 'Snowball', 'version': '3.0.0', 'url': SNOWBALL_URL, 'sha256': sha(snowball), 'upstream_commit': SNOWBALL_COMMIT, 'path': 'snowball', 'provenance_note': 'Matching development revision after the 3.0.0 tag, verified by exact English regeneration and Rust runtime source comparison.'})
    ui_lock = json.loads(source['pagefind_ui/default/package-lock.json'])
    for name in ('svelte', 'bcp-47', 'is-alphabetical', 'is-alphanumerical', 'is-decimal'):
        package = ui_lock['packages']['node_modules/' + name]
        version, url = package['version'], package['resolved']
        data = fetch(url, cache / (name + '-' + version + '.tgz'), allow_download)
        algorithm, expected = package['integrity'].split('-', 1)
        if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(data).digest()).decode('ascii') != expected:
            raise ValueError(f'UI source integrity mismatch: {name}')
        dest = 'ui-vendor/' + name + '-' + version
        package_files = unpack(data, 'package')
        files.update({dest + '/' + file: content for file, content in package_files.items()})
        ui_inputs.append({'name': name, 'version': version, 'url': url, 'sha256': sha(data), 'integrity': package['integrity'], 'path': dest})
    files['REBUILD.md'] = REBUILD.encode('utf-8')
    files['COPYING'] = files['vendor/pagefind_microjson-0.1.4/LICENCE']
    # This file lives one level above the exact upstream checkout.
    files['.cargo/config.toml'] = b'[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n'
    inventory = [{'path': PREFIX + '/' + name, 'sha256': sha(data), 'bytes': len(data)} for name, data in sorted(files.items())]
    internal = {'schema': 1, 'upstream_commit': COMMIT, 'source_inputs': inputs, 'ui_source_inputs': ui_inputs, 'files': inventory}
    files['SOURCE-MANIFEST.json'] = (json.dumps(internal, indent=2) + '\n').encode('utf-8')
    buffer = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=buffer, mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.GNU_FORMAT) as archive:
            for name, data in sorted(files.items()):
                info = tarfile.TarInfo(PREFIX + '/' + safe_name(name))
                info.size = len(data)
                info.mode = 0o755 if name.endswith('.sh') or data.startswith(b'#!') else 0o644
                info.mtime = 0
                archive.addfile(info, io.BytesIO(data))
    payload = buffer.getvalue()
    check_local_wasm(WASM_PROFILES)
    inventory.append({'path': PREFIX + '/SOURCE-MANIFEST.json', 'sha256': sha(files['SOURCE-MANIFEST.json']), 'bytes': len(files['SOURCE-MANIFEST.json'])})
    proof = {'toolchain': 'Rust 1.94.0', 'container_image': 'rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55',
             'network': 'disabled during builds', 'target': 'wasm32-unknown-unknown',
             'working_directory': '/source/pagefind-1.5.2-source/upstream/pagefind_web',
             'outputs': [{'variant': 'en', 'command': 'cargo build --locked --offline --release --target wasm32-unknown-unknown --features en', 'raw_cargo_wasm_sha256': '31a870456260adaa8847bb2c5127ac4e0e2c64b8073cc5becfc2303e8522c834'},
                         {'variant': 'unknown', 'command': 'cargo build --locked --offline --release --target wasm32-unknown-unknown --no-default-features', 'raw_cargo_wasm_sha256': 'e2804c6f6c017c3ce3faa0df9255136d3f952a7fe67950f84798d4453c20bcd6'}],
             'upstream_packaged_wasm_byte_equivalence': 'Not asserted: upstream also applies wasm-bindgen, wasm-opt and compression.',
             'snowball': {'upstream_commit': SNOWBALL_COMMIT, 'english_generated_rust_sha256': 'e83bb65144434954728488c5bd9f796f23a7d6829609db5b4f1adaed5c924a90', 'matches_published_english_and_runtime_sources': True}}
    document = {'schema': 2, 'component': 'Pagefind offline Help search', 'version': VERSION,
                'upstream_commit': COMMIT, 'upstream_source_url': SOURCE_URL,
                'archive': {'filename': ARCHIVE, 'sha256': sha(payload), 'bytes': len(payload)},
                'wasm_profiles': WASM_PROFILES, 'build_recipe': PREFIX + '/REBUILD.md',
                'source_inputs': inputs, 'ui_source_inputs': ui_inputs, 'files': sorted(inventory, key=lambda f: f['path']), 'build_verification': proof}
    DEST.mkdir(parents=True, exist_ok=True)
    (DEST / ARCHIVE).write_bytes(payload)
    (DEST / MANIFEST).write_bytes((json.dumps(document, indent=2) + '\n').encode('utf-8'))
    return document


def check():
    document = json.loads((DEST / MANIFEST).read_text(encoding='utf-8'))
    if document.get('schema') != 2 or document.get('upstream_commit') != COMMIT or document['archive']['filename'] != ARCHIVE:
        raise ValueError('Wrong pinned Pagefind source manifest')
    payload = (DEST / ARCHIVE).read_bytes()
    if len(payload) != document['archive']['bytes'] or sha(payload) != document['archive']['sha256']:
        raise ValueError('Pagefind source archive checksum mismatch')
    expected = {entry['path']: entry for entry in document['files']}
    seen = set()
    retained = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        for member in archive:
            safe_name(member.name)
            if not member.isfile() or not member.name.startswith(PREFIX + '/') or member.name in seen:
                raise ValueError('Invalid source archive member')
            total += member.size
            if total > MAX_EXPANDED or len(seen) > 15000:
                raise ValueError('Source archive exceeds size/count bound')
            if member.name not in expected:
                raise ValueError('Unlisted source archive member')
            data = archive.extractfile(member).read()
            item = expected[member.name]
            if member.size != item['bytes'] or sha(data) != item['sha256']:
                raise ValueError('Source archive member digest mismatch')
            seen.add(member.name)
            if member.name.endswith(('/SOURCE-MANIFEST.json', '/upstream/pagefind_web/Cargo.lock', '/upstream/pagefind_ui/default/package-lock.json')):
                retained[member.name] = data
    if seen != set(expected):
        raise ValueError('Source archive member missing')
    internal = json.loads(retained[PREFIX + '/SOURCE-MANIFEST.json'])
    if internal['upstream_commit'] != COMMIT or internal['source_inputs'] != document['source_inputs'] or internal['ui_source_inputs'] != document['ui_source_inputs']:
        raise ValueError('Source archive input manifest mismatch')
    internal_files = {entry['path']: entry for entry in internal['files']}
    if internal_files != {path: entry for path, entry in expected.items() if path != PREFIX + '/SOURCE-MANIFEST.json'}:
        raise ValueError('Source archive internal file manifest mismatch')
    wasm_lock = retained[PREFIX + '/upstream/pagefind_web/Cargo.lock']
    ui_lock = retained[PREFIX + '/upstream/pagefind_ui/default/package-lock.json']
    if sha(wasm_lock) != WASM_LOCK_SHA256 or sha(ui_lock) != UI_LOCK_SHA256:
        raise ValueError('Pinned upstream Pagefind lockfile changed')
    packages = closure(tomllib.loads(wasm_lock.decode('utf-8')))
    source_inputs = document['source_inputs']
    if len(source_inputs) != 23 or len({entry['name'] for entry in source_inputs}) != 23:
        raise ValueError('Wrong source input count')
    for package in packages:
        entry = next(item for item in source_inputs if item['name'] == package['name'])
        if entry['version'] != package['version']:
            raise ValueError('Locked source input version mismatch')
        if package.get('checksum') and entry['sha256'] != package['checksum']:
            raise ValueError('Locked source input checksum mismatch')
        if PREFIX + '/' + entry['path'] + '/Cargo.toml' not in seen:
            raise ValueError('Locked source package root missing')
    snowball = next(item for item in source_inputs if item['name'] == 'Snowball')
    if snowball.get('upstream_commit') != SNOWBALL_COMMIT or snowball['path'] != 'snowball' or PREFIX + '/snowball/algorithms/english.sbl' not in seen or PREFIX + '/snowball/COPYING' not in seen:
        raise ValueError('Matching Snowball preferred source missing')
    ui_packages = json.loads(ui_lock)['packages']
    ui_inputs = document['ui_source_inputs']
    ui_names = {'svelte', 'bcp-47', 'is-alphabetical', 'is-alphanumerical', 'is-decimal'}
    if len(ui_inputs) != 5 or {entry['name'] for entry in ui_inputs} != ui_names:
        raise ValueError('Wrong UI source input set')
    for entry in ui_inputs:
        package = ui_packages['node_modules/' + entry['name']]
        if entry['version'] != package['version'] or entry['integrity'] != package['integrity'] or PREFIX + '/' + entry['path'] + '/package.json' not in seen:
            raise ValueError('Pinned UI source input mismatch')
    if document.get('wasm_profiles') != WASM_PROFILES:
        raise ValueError('Wrong pinned platform WASM profiles')
    check_local_wasm(WASM_PROFILES)
    return document


def check_local_wasm(profiles):
    """Match one complete verified profile; Help's build selects native platform."""
    names = ('wasm.en.pagefind', 'wasm.unknown.pagefind')
    paths = {name: ROOT / 'help-center/dist/pagefind' / name for name in names}
    if not any(path.exists() for path in paths.values()):
        return
    if not all(path.exists() for path in paths.values()):
        raise ValueError('Built Help WASM pair incomplete')
    observed = {name: path.read_bytes() for name, path in paths.items()}
    matches = []
    for key, profile in profiles.items():
        if {record['filename'] for record in profile['wasm']} != set(names):
            raise ValueError('Pinned WASM profile file set invalid')
        if all(len(observed[r['filename']]) == r['bytes'] and sha(observed[r['filename']]) == r['sha256'] for r in profile['wasm']):
            matches.append((key, profile))
    if len(matches) != 1:
        raise ValueError('Built Help WASM pair does not match a single verified native profile')
    for record in matches[0][1]['wasm']:
        raw = zlib.decompress(observed[record['filename']], wbits=31)
        if not raw.startswith(b'pagefind_dcd\0asm'):
            raise ValueError('Pagefind decoded WASM header invalid')
        module = raw[len(b'pagefind_dcd'):]
        if len(raw) != record['uncompressed_bytes'] or sha(raw) != record['uncompressed_sha256'] or len(module) != record['decoded_wasm_bytes'] or sha(module) != record['decoded_wasm_sha256']:
            raise ValueError('Pagefind decoded WASM digest differs from native profile')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--cache', type=Path, default=ROOT / '.local/pagefind-source-inputs')
    args = parser.parse_args()
    if args.check and args.download:
        parser.error('--check never downloads')
    document = check() if args.check else build(args.cache, args.download)
    print(f"Pagefind source verified: {document['archive']['bytes']} bytes, {len(document['files'])} files, {len(document['source_inputs'])} source inputs")


if __name__ == '__main__':
    main()
