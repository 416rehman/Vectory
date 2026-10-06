#!/usr/bin/env python3
"""Run the actual starter and real Compose parser against stale caller settings.

Only Docker container operations are stubbed. Compose configuration is parsed
by the installed Docker Compose executable and no Docker daemon is required.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


if not sys.platform.startswith('linux') or not shutil.which('docker'):
    raise SystemExit('This regression requires Linux and Docker Compose.')
module_spec = importlib.util.spec_from_file_location('starter_fixture', Path(__file__).with_name('test-starter-recovery.py'))
fixture_module = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(fixture_module)


class ComposeEnvironmentTests(unittest.TestCase):
    def test_source_compose_files_parse_and_preserve_validator_isolation(self):
        root = Path(__file__).resolve().parents[1]
        environment = {key: value for key, value in os.environ.items() if not key.startswith('VECTORY_')}
        environment.update({
            'VECTORY_HOSTNAME': 'vectory.example.invalid',
            'VECTORY_TLS_CERT_FILE': '/tmp/vectory-compose-fixture/server.pem',
            'VECTORY_TLS_KEY_FILE': '/tmp/vectory-compose-fixture/server-key.pem',
            'VECTORY_BOOTSTRAP_SECRET_FILE': '/tmp/vectory-compose-fixture/bootstrap',
            'VECTORY_SERVER_IMAGE': 'vectory-server:parser-fixture',
            'VECTORY_VALIDATOR_IMAGE': 'vectory-validator:parser-fixture',
            'VECTORY_PREVIEW_SERVER_IMAGE': 'vectory-server:parser-fixture',
            'VECTORY_PREVIEW_VALIDATOR_IMAGE': 'vectory-validator:parser-fixture',
            'VECTORY_PREVIEW_PROJECT': 'vectory-compose-fixture',
            'VECTORY_PREVIEW_WEB_PORT': '18080',
            'VECTORY_PREVIEW_AGENT_PORT': '18443',
            'VECTORY_PREVIEW_VALIDATION_URL': 'http://172.30.0.2:8081',
            'VECTORY_PREVIEW_NO_PROXY': 'localhost,127.0.0.1,::1,172.30.0.2',
        })
        for name in ('compose.yaml', 'compose.preview.yaml', 'compose.release.yaml', 'compose.auto.yaml'):
            with self.subTest(compose=name):
                result = subprocess.run(
                    ['docker', 'compose', '--env-file', os.devnull, '-f', str(root / 'deploy' / name),
                     'config', '--format', 'json'],
                    env=environment, capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                config = json.loads(result.stdout)
                validator = config['services']['validator']
                self.assertTrue(config['networks']['validation']['internal'])
                self.assertEqual(set(validator['networks']), {'validation'})
                self.assertFalse(validator.get('ports'))
                self.assertTrue(validator['read_only'])
                self.assertEqual(validator['cap_drop'], ['ALL'])
                self.assertEqual(validator['user'], '10002:10002')
                if name != 'compose.yaml':
                    for service in config['services'].values():
                        self.assertEqual(service['pull_policy'], 'never')

    def test_custom_and_automatic_resume_keep_operator_settings_and_verified_refs(self):
        for automatic in (False, True):
            with self.subTest(automatic=automatic), tempfile.TemporaryDirectory(prefix='vectory-real-compose-') as temporary:
                fixture = fixture_module.Fixture(Path(temporary), 'server')
                result = fixture.run()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                retained = fixture.retained_files()
                previous = (fixture.bundle / '.env').read_text()
                verified = dict(line.split('=', 1) for line in previous.splitlines())
                previous = previous.replace(verified['VECTORY_SERVER_IMAGE'], 'example/unverified:old-manager')
                previous = previous.replace(verified['VECTORY_VALIDATOR_IMAGE'], 'example/unverified:old-validator')
                if automatic:
                    previous += 'VECTORY_CERTIFICATE_MODE=automatic\n'
                previous += ('VECTORY_PUBLIC_AGENT_DOWNLOADS=false\nVECTORY_MAX_AGENT_CONNECTIONS=37\n'
                             'VECTORY_TELEMETRY_RETENTION_DAYS=23\nVECTORY_RELEASES_DIRECTORY=./operator-releases\n')
                (fixture.bundle / '.env').write_text(previous)
                fixture.env.update({
                    'VECTORY_SERVER_IMAGE': 'example/unverified:caller-manager',
                    'VECTORY_VALIDATOR_IMAGE': 'example/unverified:caller-validator',
                    'VECTORY_HOSTNAME': 'stale.example.invalid', 'VECTORY_BIND_IP': '192.0.2.9',
                    'VECTORY_CERTIFICATE_MODE': 'custom' if automatic else 'automatic',
                    'VECTORY_PUBLIC_AGENT_DOWNLOADS': 'true', 'VECTORY_MAX_AGENT_CONNECTIONS': '999',
                    'VECTORY_TELEMETRY_RETENTION_DAYS': '999', 'VECTORY_RELEASES_DIRECTORY': './wrong-releases',
                    'STUB_COMPOSE_EXE': shutil.which('docker'),
                    'STUB_COMPOSE_RESULT': str(Path(temporary) / 'compose.json'),
                })
                result = fixture.run()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(retained, fixture.retained_files(), 'resume changed retained certificate or bootstrap')
                config = json.loads((Path(temporary) / 'compose.json').read_text())
                services = config['services']
                self.assertEqual(services['server']['image'], verified['VECTORY_SERVER_IMAGE'])
                self.assertEqual(services['validator']['image'], verified['VECTORY_VALIDATOR_IMAGE'])
                environment = services['server']['environment']
                self.assertEqual(environment['VECTORY_PUBLIC_URL'], 'https://vectory.example.com')
                self.assertEqual(environment['VECTORY_PUBLIC_AGENT_DOWNLOADS'], 'false')
                self.assertEqual(environment['VECTORY_MAX_AGENT_CONNECTIONS'], '37')
                self.assertEqual(environment['VECTORY_TELEMETRY_RETENTION_DAYS'], '23')
                self.assertTrue(all(port['host_ip'] == '127.0.0.1' for port in services['proxy']['ports']))
                mirror = next(mount for mount in services['server']['volumes'] if mount['target'] == '/app/releases')
                self.assertEqual(mirror['source'], str(fixture.bundle / 'operator-releases'))
                self.assertEqual('certificates' in services, automatic)
                stored = (fixture.bundle / '.env').read_text()
                self.assertIn('VECTORY_PUBLIC_AGENT_DOWNLOADS=false\n', stored)
                self.assertNotIn('example/unverified:', stored)


if __name__ == '__main__':
    unittest.main(verbosity=2)
