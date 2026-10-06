#!/usr/bin/env python3
"""Test signed offline-loader decisions with explicit Docker/Cosign stand-ins.

These rejection fixtures execute Bash and SHA-256 checks, not real Sigstore
cryptography. The actual signature path is separately required after publishing.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
COSIGN_ID = 'sha256:192a38e9dabb6b28359fc4706992d91ad325f366630a68dd7c3d50bcef059db8'
PROXY_ID = 'sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77'
SERVER_CONFIG = b'{"architecture":"amd64","os":"linux","component":"server"}'
VALIDATOR_CONFIG = b'{"architecture":"amd64","os":"linux","component":"validator"}'
SERVER_ID, VALIDATOR_ID = 'sha256:' + hashlib.sha256(SERVER_CONFIG).hexdigest(), 'sha256:' + hashlib.sha256(VALIDATOR_CONFIG).hexdigest()

STUB = r'''#!/usr/bin/python3
import hashlib,json,os,tarfile
from pathlib import Path
import sys
args=sys.argv[1:]
state=Path(os.environ['STUB_STATE'])
images=json.loads(state.read_text())
with open(os.environ['STUB_LOG'],'a') as log: log.write(json.dumps(args)+'\n')
if args[:2]==['image','inspect']:
 identity=args[2]
 found=next((record for record in images if identity in (record['Id'],record.get('Tag'))),None)
 if found is None: sys.exit(1)
 if '--format' in args:
  print('linux/amd64' if args[args.index('--format')+1]=='{{.Os}}/{{.Architecture}}' else found['Id'])
 sys.exit(0)
if args[0]=='load':
 path=Path(args[args.index('--input')+1])
 try:
  if path.name.startswith('vectory-'):
   with tarfile.open(path,'r:gz') as archive:
    manifest=json.load(archive.extractfile('manifest.json'))[0]
    loaded={'Id':'sha256:'+hashlib.sha256(archive.extractfile(manifest['Config']).read()).hexdigest(),'Tag':manifest['RepoTags'][0]}
  else: loaded={'Id':json.loads(path.read_text())['Id']}
 except (OSError,ValueError,KeyError,tarfile.TarError): sys.exit(1)
 images.append(loaded);state.write_text(json.dumps(images));sys.exit(0)
if args[0]=='run' and 'verify-blob' in args:
 assert '--pull=never' in args and args[args.index('--network')+1]=='none'
 cache=Path(os.environ['STUB_CACHE'])
 proof=json.loads((cache/'SHA256SUMS.sigstore.json').read_text())
 expected=hashlib.sha256((cache/'SHA256SUMS').read_bytes()).hexdigest()
 sys.exit(0 if proof.get('EXPLICIT_TEST_STANDIN')==expected else 1)
raise SystemExit('Unexpected Docker operation in offline rejection fixture')
'''


@unittest.skipUnless(sys.platform.startswith('linux'), 'requires Linux Bash')
class OfflineLoaderTests(unittest.TestCase):
    def fixture(self, temporary, mutation):
        bundle = Path(temporary)
        cache = bundle / '.cache'
        cache.mkdir()
        (bundle / 'Caddyfile').write_text('fixture proxy configuration')
        (bundle / 'verify-release.sh').write_bytes((ROOT / 'verify-release.sh').read_bytes())
        root = cache / 'sigstore/.sigstore/root/tuf-repo-cdn.sigstore.dev/targets'
        root.mkdir(parents=True)
        (root / 'trusted_root.json').write_text('{"EXPLICIT_TEST_STANDIN": true}')
        (cache / 'IMAGE-DIGESTS.env').write_text('VECTORY_SERVER_IMAGE=ghcr.io/416rehman/vectory-server@sha256:' + 'a' * 64 + '\nVECTORY_VALIDATOR_IMAGE=ghcr.io/416rehman/vectory-validator@sha256:' + 'b' * 64 + '\n')
        (cache / 'IMAGE-CONFIGS.env').write_text('VECTORY_SERVER_IMAGE=' + SERVER_ID + '\nVECTORY_VALIDATOR_IMAGE=' + VALIDATOR_ID + '\n')
        for name, identity in (('cosign', COSIGN_ID), ('proxy', PROXY_ID)):
            (cache / (name + '-image.tar.gz')).write_text(json.dumps({'Id': identity}))
        for component, data in (('server', SERVER_CONFIG), ('validator', VALIDATOR_CONFIG)):
            config_name = hashlib.sha256(data).hexdigest() + '.json'
            contents = {'manifest.json': json.dumps([{'RepoTags': ['vectory-' + component + ':candidate'], 'Config': config_name}]).encode(), config_name: data}
            with tarfile.open(cache / ('vectory-' + component + '-image.tar.gz'), 'w:gz') as archive:
                for name, payload in contents.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(payload)
                    archive.addfile(member, io.BytesIO(payload))
        signed = ('IMAGE-DIGESTS.env', 'IMAGE-CONFIGS.env', 'vectory-server-image.tar.gz', 'vectory-validator-image.tar.gz')
        (cache / 'SHA256SUMS').write_text(''.join(hashlib.sha256((cache / name).read_bytes()).hexdigest() + '  ' + name + '\n' for name in signed))
        (cache / 'SHA256SUMS.sigstore.json').write_text(json.dumps({'EXPLICIT_TEST_STANDIN': hashlib.sha256((cache / 'SHA256SUMS').read_bytes()).hexdigest()}))
        if mutation == 'signature': (cache / 'SHA256SUMS.sigstore.json').write_text('{}')
        if mutation == 'config': (cache / 'IMAGE-CONFIGS.env').write_text('VECTORY_SERVER_IMAGE=mutable:latest\n')
        if mutation == 'archive': (cache / 'vectory-server-image.tar.gz').write_text('{"Id":"wrong"}')
        if mutation == 'verifier': (cache / 'cosign-image.tar.gz').write_text('{"Id":"wrong"}')
        if mutation == 'proxy': (cache / 'proxy-image.tar.gz').write_text('{"Id":"wrong"}')
        if mutation == 'trust': (root / 'trusted_root.json').unlink()
        binary = bundle / 'bin'
        binary.mkdir()
        stub = binary / 'docker'
        stub.write_text(STUB.replace('#!/usr/bin/python3', '#!' + sys.executable, 1))
        stub.chmod(0o700)
        state, log = bundle / 'images.json', bundle / 'commands.jsonl'
        state.write_text('[]')
        log.touch()
        env = os.environ.copy()
        env.update({'PATH': str(binary) + ':/usr/bin:/bin', 'VECTORY_OFFLINE': 'true', 'STUB_STATE': str(state), 'STUB_LOG': str(log), 'STUB_CACHE': str(cache)})
        script = 'set -euo pipefail; bundle="$PWD"; version=0.2.0; fail(){ echo "$*" >&2; exit 1; }; say(){ :; }; source ./verify-release.sh; load_signed_images; printf "%s\\n%s\\n%s\\n" "$server_image" "$validator_image" "$proxy_image"'
        result = subprocess.run(['bash', '-c', script], cwd=bundle, env=env, capture_output=True, text=True, timeout=15)
        return result, [json.loads(line) for line in log.read_text().splitlines()]

    def test_fresh_offline_load_selects_signed_local_ids_without_registry_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            result, commands = self.fixture(temporary, '')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), [SERVER_ID, VALIDATOR_ID, PROXY_ID])
            self.assertEqual(sum(command[0] == 'load' for command in commands), 4)
            self.assertFalse(any(command[0] in ('pull', 'compose') for command in commands))

    def test_bad_proof_manifest_archives_or_dependency_never_reach_manager_start(self):
        for mutation in ('signature', 'config', 'archive', 'verifier', 'proxy', 'trust'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                result, commands = self.fixture(temporary, mutation)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(command[0] in ('pull', 'compose') for command in commands))


if __name__ == '__main__':
    unittest.main(verbosity=2)
