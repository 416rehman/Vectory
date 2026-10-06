#!/usr/bin/env python3
"""Exercise real portable Bash installer control flow with fixture-only commands.

No Docker daemon, network, certificate issuance or host activation is involved.
Run: python3 deploy/test-desktop-installer.py
Windows may set VECTORY_TEST_BASH to its existing Git Bash executable. That
harness omits POSIX chmod operations on NTFS; it does not qualify Unix file modes.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHELL_SOURCE = (ROOT/'deploy/install-desktop.sh').read_text()
POWERSHELL_SOURCE = (ROOT/'deploy/install.ps1').read_text()
VERSION = re.search(r"^version='([^']+)'", SHELL_SOURCE, re.M).group(1)
KIT = f'vectory-{VERSION}-server-linux-amd64'
SERVER = 'ghcr.io/416rehman/vectory-server@sha256:' + '1' * 64
VALIDATOR = 'ghcr.io/416rehman/vectory-validator@sha256:' + '2' * 64
SERVER_CONFIG = 'sha256:' + '3' * 64
VALIDATOR_CONFIG = 'sha256:' + '4' * 64
PROXY_CONFIG = 'sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77'
MEMBERS = '.env.example Caddyfile Caddyfile.auto LICENSE NOTICE README.md SHA256SUMS VERSION compose.auto.yaml compose.yaml prepare-offline.sh release-images.sh start-auto.sh start.sh verify-release.sh'.split()

def shell_path(path):
    value = str(path).replace('\\', '/')
    if os.name == 'nt' and len(value) > 2 and value[1] == ':':
        return '/' + value[0].lower() + value[2:]
    return value

DOCKER = r'''#!/usr/bin/env bash
set -eu
printf '%q ' "$@" >> "$TEST_LOG"; printf '\n' >> "$TEST_LOG"
case "${1:-}" in
  info) [[ $# == 1 ]] || printf '%s\n' "${TEST_ENGINE:-linux/amd64}" ;;
  pull) [[ "$2" == --platform && "$3" == linux/amd64 ]] || exit 81 ;;
  image)
    if [[ "${5:-}" == '{{.Os}}/{{.Architecture}}' ]]; then printf '%s\n' "${TEST_IMAGE_PLATFORM:-linux/amd64}"; exit 0; fi
    if [[ "${TEST_IMAGE_ID_STYLE:-config}" == manifest && "$3" == *@sha256:* ]]; then printf '%s\n' "${3##*@}"; exit 0; fi
    if [[ "${TEST_IMAGE_ID_STYLE:-config}" == wrong ]]; then printf 'sha256:%s\n' "$(printf '%064d' 0 | tr 0 5)"; exit 0; fi
    case "$3" in
      *vectory-server@*) printf 'sha256:%s\n' "$(printf '%064d' 0 | tr 0 3)" ;;
      *vectory-validator@*) printf 'sha256:%s\n' "$(printf '%064d' 0 | tr 0 4)" ;;
      caddy:*) printf '%s\n' 'sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77' ;;
      *) exit 82 ;;
    esac ;;
  volume) [[ "$2" == create ]] || exit 83 ;;
  run)
    case " $* " in *' --platform linux/amd64 '*) ;; *) exit 84 ;; esac
    case " $* " in
      *' verify-blob '*) [[ "${TEST_FAIL_SIGNATURE:-false}" != true ]] || exit 85 ;;
      *' verify '*) [[ "${TEST_FAIL_IMAGE_SIGNATURE:-false}" != true ]] || exit 86 ;;
      *' --server-cert '*) [[ "${TEST_FAIL_PKI:-false}" != true ]] || exit 87 ;;
      *'for name in server_cert server_key'*) [[ "${TEST_FAIL_COMMIT:-false}" != true ]] || exit 94 ;;
      *'printf retained'*) [[ "${TEST_RETAINED:-false}" != true ]] || printf retained ;;
      *' --entrypoint '*) ;;
      *) exit 88 ;;
    esac ;;
  compose)
    if [[ "${2:-}" == version ]]; then printf 'Docker Compose version v2.39.4\n'; exit 0; fi
    [[ -z "${VECTORY_SERVER_IMAGE:-}" && -z "${VECTORY_PROXY_IMAGE:-}" && -z "${VECTORY_HOSTNAME:-}" ]] || exit 89
    case " $* " in
      *' config --quiet '*|*' up -d --wait --wait-timeout 300 '*|*' stop '*|*' ps '*) ;;
      *' curl --fail --silent '*) printf '{"initialized":true}\n' ;;
      *' cat /run/secrets/bootstrap '*) printf '%064d\n' 0 ;;
      *) exit 90 ;;
    esac ;;
  *) exit 91 ;;
esac
'''

CURL = r'''#!/usr/bin/env bash
set -eu
[[ "${TEST_FAIL_DOWNLOAD:-false}" != true ]] || exit 98
name=''; output=''
while [[ $# -gt 0 ]]; do
  case "$1" in https://github.com/416rehman/Vectory/releases/download/*) name="${1##*/}" ;; -o) shift; output="$1" ;; esac
  shift
done
[[ -n "$name" && -n "$output" && -f "$TEST_RELEASE/$name" ]] || exit 92
cp "$TEST_RELEASE/$name" "$output"
'''

class DesktopInstaller(unittest.TestCase):
    JOURNAL = '.setup.desktop.env'
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='vectory-desktop-test-')
        self.addCleanup(self.temp.cleanup)
        self.area = Path(self.temp.name)
        self.commands = self.area / 'bin'; self.commands.mkdir()
        self.release = self.area / 'release'; self.release.mkdir()
        self.target = self.area / 'install'
        self.log = self.area / 'commands.log'
        self.shell_script = self.area/'fixture-installer.sh'
        self.shell_script.write_text(SHELL_SOURCE, newline='\n')
        for name, content in {'docker':DOCKER,'curl':CURL,'uname':'#!/usr/bin/env bash\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; *) exit 93 ;; esac\n'}.items():
            path = self.commands / name; path.write_text(content, newline='\n'); path.chmod(0o755)
        if os.name == 'nt':
            for name,content in {'mkdir':'#!/usr/bin/env bash\n[[ "${1:-}" != -m ]] || shift 2\nexec /usr/bin/mkdir "$@"\n', 'chmod':'#!/usr/bin/env bash\nexit 0\n'}.items():
                path = self.commands/name; path.write_text(content,newline='\n'); path.chmod(0o755)
        files = {name:(b'# Synthetic fixture only.\n') for name in MEMBERS if name != 'SHA256SUMS'}
        files['VERSION'] = (VERSION+'\n').encode()
        files['SHA256SUMS'] = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name,data in sorted(files.items())).encode()
        archive = self.release / (KIT+'.tar.gz')
        with tarfile.open(archive, 'w:gz') as out:
            for name,data in files.items():
                item = tarfile.TarInfo(KIT+'/'+name); item.size = len(data); item.mode = 0o644
                out.addfile(item, io.BytesIO(data))
        (self.release/'IMAGE-DIGESTS.env').write_text(f'VECTORY_SERVER_IMAGE={SERVER}\nVECTORY_VALIDATOR_IMAGE={VALIDATOR}\n', newline='\n')
        (self.release/'IMAGE-CONFIGS.env').write_text(f'VECTORY_SERVER_IMAGE={SERVER_CONFIG}\nVECTORY_VALIDATOR_IMAGE={VALIDATOR_CONFIG}\n', newline='\n')
        (self.release/'SHA256SUMS.sigstore.json').write_text('{}\n', newline='\n')
        (self.release/'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in sorted(self.release.iterdir()) if path.name != 'SHA256SUMS'), newline='\n')
        self.env = dict(os.environ, VECTORY_INSTALL_DIRECTORY=shell_path(self.target), VECTORY_HOSTNAME='vectory.example.com', VECTORY_SERVER_PROJECT='fixture-vectory', TEST_LOG=shell_path(self.log), TEST_RELEASE=shell_path(self.release))
        self.env['PATH'] = shell_path(self.commands) + os.pathsep + self.env['PATH']
        self.env['TEST_BIN'] = shell_path(self.commands)
        self.env['TEST_SCRIPT'] = shell_path(self.shell_script)
        self.bash = os.environ.get('VECTORY_TEST_BASH') or shutil.which('bash')
        if not self.bash: self.skipTest('Bash is unavailable')

    def run_installer(self, action='start', **values):
        env = dict(self.env, **values)
        # Git Bash requires a POSIX PATH separator inside its process.
        if os.name == 'nt':
            env['PATH'] = shell_path(self.commands) + ';' + os.environ['PATH']
        env['TEST_ACTION'] = action
        result = subprocess.run([self.bash, '-c', 'export PATH="$TEST_BIN:$PATH"; exec bash "$TEST_SCRIPT" "$TEST_ACTION"'], env=env, capture_output=True, text=True, input='n\n', timeout=30)
        return result

    def lines(self): return self.log.read_text() if self.log.exists() else ''

    def test_start_resume_and_stop_retain_state_and_ignore_inherited_image_override(self):
        first = self.run_installer(VECTORY_SERVER_IMAGE='attacker:latest', VECTORY_PROXY_IMAGE='attacker:latest')
        self.assertEqual(first.returncode, 0, first.stderr)
        before = (self.target/'.env').read_bytes()
        self.assertEqual(self.run_installer().returncode, 0)
        self.assertEqual((self.target/'.env').read_bytes(), before)
        self.assertEqual(self.run_installer('stop').returncode, 0)
        self.assertNotIn('attacker:latest', before.decode())
        self.assertIn('platform: linux/amd64', (self.target/'.desktop-platform.yaml').read_text())

    def test_signature_failure_starts_no_state_helper(self):
        result = self.run_installer(TEST_FAIL_SIGNATURE='true')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('volume create', self.lines())
        self.assertFalse((self.target/'.env').exists())

    def test_first_download_failure_resumes_same_owned_directory(self):
        failed = self.run_installer(TEST_FAIL_DOWNLOAD='true')
        self.assertNotEqual(failed.returncode, 0)
        self.assertTrue((self.target/'.desktop-installing').exists())
        retried = self.run_installer()
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertFalse((self.target/'.desktop-installing').exists())

    def test_first_signature_failure_resumes_same_owned_directory(self):
        failed = self.run_installer(TEST_FAIL_SIGNATURE='true')
        self.assertNotEqual(failed.returncode, 0)
        self.assertTrue((self.target/'.desktop-installing').exists())
        retried = self.run_installer()
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertFalse((self.target/'.desktop-installing').exists())

    def test_unknown_existing_content_is_refused_and_preserved(self):
        self.target.mkdir(); notes = self.target/'notes.txt'; notes.write_text('operator owned data')
        refused = self.run_installer()
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(notes.read_text(), 'operator owned data')
        self.assertFalse((self.target/'.cache').exists())

    def test_interrupted_cache_link_is_refused(self):
        self.assertNotEqual(self.run_installer(TEST_FAIL_SIGNATURE='true').returncode, 0)
        original = self.target/'.cache'; outside = self.area/'retained-cache'
        self.assertTrue(original.resolve().is_relative_to(self.area.resolve()))
        self.assertTrue(outside.resolve().is_relative_to(self.area.resolve()))
        original.rename(outside)
        try: original.symlink_to(outside, target_is_directory=True)
        except OSError:
            if os.name == 'nt' and isinstance(self, WindowsDesktopInstaller):
                helper = self.area/'junction.ps1'
                helper.write_text('param([string]$Link,[string]$Target)\nNew-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n', newline='\n')
                result = subprocess.run(['powershell.exe','-NoProfile','-File',str(helper),str(original),str(outside)],capture_output=True,text=True,timeout=15)
                if result.returncode: self.skipTest('This Windows account cannot create the fixture reparse point')
            else: self.skipTest('This account cannot create the fixture directory symlink')
        refused = self.run_installer()
        self.assertNotEqual(refused.returncode, 0)
        self.assertTrue((outside/'SHA256SUMS').exists())

    def test_image_signature_failure_starts_no_state_helper(self):
        result = self.run_installer(TEST_FAIL_IMAGE_SIGNATURE='true')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('volume create', self.lines())

    def test_containerd_manifest_identity_is_accepted_but_other_digest_is_refused(self):
        accepted = self.run_installer(TEST_IMAGE_ID_STYLE='manifest')
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.log.write_text('')
        refused = self.run_installer(TEST_IMAGE_ID_STYLE='wrong')
        self.assertNotEqual(refused.returncode, 0)
        self.assertNotIn('volume create', self.lines())

    def test_signed_reference_with_wrong_execution_platform_refuses_before_helpers(self):
        refused = self.run_installer(TEST_IMAGE_PLATFORM='linux/arm64')
        self.assertNotEqual(refused.returncode, 0)
        self.assertNotIn('volume create', self.lines())

    def test_arm_requires_consent_and_explicit_platform_is_used(self):
        refused = self.run_installer(TEST_ENGINE='linux/aarch64')
        self.assertNotEqual(refused.returncode, 0)
        self.assertFalse(self.target.exists())
        allowed = self.run_installer(TEST_ENGINE='linux/aarch64', VECTORY_ALLOW_AMD64_EMULATION='true')
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertNotIn('run --rm', self.lines())
        self.assertIn('pull --platform linux/amd64', self.lines())

    def test_tampered_archive_is_rejected_before_extraction(self):
        archive = self.release/(KIT+'.tar.gz'); archive.write_bytes(archive.read_bytes()+b'changed')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.target/'VERSION').exists())

    def test_changed_retained_hostname_and_platform_override_refuse_before_helpers(self):
        self.assertEqual(self.run_installer().returncode, 0)
        self.log.write_text('')
        changed = self.run_installer(VECTORY_HOSTNAME='other.example.com')
        self.assertNotEqual(changed.returncode, 0)
        self.assertNotIn('volume create', self.lines())
        (self.target/'.desktop-platform.yaml').write_text('services: {}\n')
        self.assertNotEqual(self.run_installer().returncode, 0)

    def pem_settings(self):
        cert = self.area/'certificate.pem'; key = self.area/'key.pem'
        cert.write_text('-----BEGIN CERTIFICATE-----\nU1lOVEhFVElD\n-----END CERTIFICATE-----\n', newline='\n')
        key.write_text('-----BEGIN PRIVATE KEY-----\nU1lOVEhFVElD\n-----END PRIVATE KEY-----\n', newline='\n')
        return {'VECTORY_CERTIFICATE_MODE':'custom','VECTORY_TLS_CERT_FILE':shell_path(cert),'VECTORY_TLS_KEY_FILE':shell_path(key)}

    def test_custom_certificate_path_uses_original_custom_template(self):
        result = self.run_installer(**self.pem_settings())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('VECTORY_CERTIFICATE_MODE=custom', (self.target/'.env').read_text())
        self.assertNotIn('certificates:', (self.target/'.desktop-platform.yaml').read_text())
        self.assertFalse((self.target/self.JOURNAL).exists())
        self.assertIn('/compose.yaml', self.lines())

    def test_custom_validation_failure_never_commits_setup(self):
        result = self.run_installer(**dict(self.pem_settings(), TEST_FAIL_PKI='true'))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.target/'.env').exists())
        self.assertFalse((self.target/self.JOURNAL).exists())

    def test_custom_interrupted_commit_resumes_original_journal(self):
        result = self.run_installer(**dict(self.pem_settings(), TEST_FAIL_COMMIT='true'))
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.target/self.JOURNAL).exists())
        self.assertFalse((self.target/'.env').exists())
        recovered = self.run_installer(VECTORY_CERTIFICATE_MODE='custom')
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertFalse((self.target/self.JOURNAL).exists())

    def test_custom_missing_environment_refuses_existing_trust(self):
        result = self.run_installer(**dict(self.pem_settings(), TEST_RETAINED='true'))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.target/'.env').exists())
        self.assertFalse((self.target/self.JOURNAL).exists())

WINDOWS_MOCK = r'''
# Test-only commands, inserted into a temporary source copy. No real Docker or network.
function Invoke-Docker([string[]]$Arguments) {
    Add-Content -LiteralPath $env:TEST_LOG -Value ($Arguments | ConvertTo-Json -Compress) -Encoding UTF8
    switch ($Arguments[0]) {
        'info' { if ($env:TEST_ENGINE) { return $env:TEST_ENGINE }; return 'linux/amd64' }
        'pull' { if ($Arguments[1] -ne '--platform' -or $Arguments[2] -ne 'linux/amd64') { Refuse 'Test detected omitted pull platform.' }; return }
        'image' {
            if ($Arguments[-1] -eq '{{.Os}}/{{.Architecture}}') { if ($env:TEST_IMAGE_PLATFORM) { return $env:TEST_IMAGE_PLATFORM }; return 'linux/amd64' }
            if ($env:TEST_IMAGE_ID_STYLE -eq 'manifest') { return $Arguments[2].Substring($Arguments[2].IndexOf('@')+1) }
            if ($env:TEST_IMAGE_ID_STYLE -eq 'wrong') { return ('sha256:' + '5' * 64) }
            if ($Arguments[2] -match 'vectory-server@') { return ('sha256:' + '3' * 64) }
            if ($Arguments[2] -match 'vectory-validator@') { return ('sha256:' + '4' * 64) }
            if ($Arguments[2] -match '^caddy:') { return 'sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77' }
            Refuse 'Unknown test image.'
        }
        'volume' { if ($Arguments[1] -ne 'create') { Refuse 'Unknown test volume action.' }; return }
        'run' {
            if ($Arguments -notcontains 'linux/amd64') { Refuse 'Test detected omitted run platform.' }
            $joined = $Arguments -join ' '
            if ($Arguments -contains 'verify-blob' -and $env:TEST_FAIL_SIGNATURE -eq 'true') { Refuse 'Synthetic signature failure.' }
            if ($Arguments -contains 'verify' -and $env:TEST_FAIL_IMAGE_SIGNATURE -eq 'true') { Refuse 'Synthetic image signature failure.' }
            if ($Arguments -contains '--server-cert' -and $env:TEST_FAIL_PKI -eq 'true') { Refuse 'Synthetic certificate validation failure.' }
            if ($joined.Contains('for name in server_cert server_key') -and $env:TEST_FAIL_COMMIT -eq 'true') { Refuse 'Synthetic commit interruption.' }
            if ($joined.Contains('printf retained') -and $env:TEST_RETAINED -eq 'true') { return 'retained' }
            return
        }
        'compose' {
            if ($Arguments[1] -eq 'version') { return 'Docker Compose version v2.39.4' }
            if ($env:VECTORY_SERVER_IMAGE -or $env:VECTORY_PROXY_IMAGE -or $env:VECTORY_HOSTNAME) { Refuse 'Compose inherited unverified settings.' }
            if ($Arguments -contains 'curl') { return '{"initialized":true}' }
            if ($Arguments -contains '/run/secrets/bootstrap') { return ('0' * 64) }
            return
        }
        default { Refuse 'Unknown test Docker command.' }
    }
}
function Download([string]$Name, [string]$Destination, [int]$Maximum) {
    if ($env:TEST_FAIL_DOWNLOAD -eq 'true') { Refuse 'Synthetic first-download failure.' }
    Copy-Item -LiteralPath (Join-Path $env:TEST_RELEASE $Name) -Destination $Destination
}
function DockerPem([string[]]$Arguments,[string]$Text) { Invoke-Docker $Arguments | Out-Null }
'''

@unittest.skipUnless(os.name == 'nt', 'Native PowerShell fixture control flow runs on Windows')
class WindowsDesktopInstaller(DesktopInstaller):
    JOURNAL = '.setup.desktop.json'

    def setUp(self):
        super().setUp()
        source = POWERSHELL_SOURCE
        marker = "try {\n    if ($env:OS"
        self.assertEqual(source.count(marker), 1)
        source = source.replace(marker, WINDOWS_MOCK + '\n' + marker)
        self.wrapper = self.area/'fixture-installer.ps1'
        self.wrapper.write_text(source, newline='\n')

    def run_installer(self, action='start', **values):
        # Windows environment names are case-insensitive; os.environ exposes
        # uppercase names, so overrides must not create duplicate spellings.
        env = dict(self.env)
        env.update({name.upper(): value for name, value in values.items()})
        env['TEST_RELEASE'] = str(self.release); env['TEST_LOG'] = str(self.log)
        args = ['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(self.wrapper),'-Action',action,'-Directory',str(self.target),'-Hostname',env['VECTORY_HOSTNAME'],'-Project',env['VECTORY_SERVER_PROJECT']]
        if env.get('VECTORY_CERTIFICATE_MODE'): args += ['-CertificateMode',env['VECTORY_CERTIFICATE_MODE']]
        for name,option in [('VECTORY_TLS_CERT_FILE','-CertificateFile'),('VECTORY_TLS_KEY_FILE','-KeyFile')]:
            if env.get(name):
                value = env[name]
                if re.match(r'^/[a-z]/',value): value = value[1].upper()+':'+value[2:]
                args += [option,value]
        if env.get('VECTORY_ALLOW_AMD64_EMULATION') == 'true': args += ['-AllowAmd64Emulation']
        return subprocess.run(args,env=env,capture_output=True,text=True,timeout=30)

    def lines(self):
        if not self.log.exists(): return ''
        return '\n'.join(' '.join(json.loads(line)).replace('\\','/') for line in self.log.read_text(encoding='utf-8-sig').splitlines())

    def test_core_module_path_does_not_break_windows_powershell_private_settings(self):
        core = shutil.which('pwsh')
        if not core: self.skipTest('PowerShell 7 is unavailable for the inherited-module regression')
        core_modules = Path(core).parent/'Modules'
        if not (core_modules/'Microsoft.PowerShell.Security').is_dir():
            self.skipTest('PowerShell 7 built-in Security module is unavailable')
        result = self.run_installer(PSModulePath=str(core_modules))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.target/'.env').is_file())
        self.assertIn('up -d --wait', self.lines())

if __name__ == '__main__': unittest.main()
