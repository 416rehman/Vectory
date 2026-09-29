"""Disposable Vector binary re-adoption proof. No daemon, network or workload start."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--agent', type=Path, required=True)
    parser.add_argument('--vector', type=Path, default=ROOT / '.local/tools/vector-0.58.0/bin/vector.exe')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    agent, upstream, output = args.agent.resolve(), args.vector.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    fixture = output / ('fixture-' + str(uuid.uuid4()))
    binary_dir, managed_dir, state_dir = fixture / 'bin', fixture / 'managed', fixture / 'state'
    binary_dir.mkdir(parents=True)
    managed_dir.mkdir()
    binary = binary_dir / 'vector.exe'
    managed = managed_dir / 'managed.json'
    shutil.copyfile(upstream, binary)
    managed.write_text(json.dumps({'sources': {'synthetic': {'type': 'demo_logs', 'format': 'json'}}, 'sinks': {'discard': {'type': 'blackhole', 'inputs': ['synthetic']}}}), encoding='utf-8')
    commands = []

    def call(exe: Path, *arguments):
        p = subprocess.run([str(exe), *map(str, arguments)], capture_output=True, text=True, timeout=40, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        # No credentials, network endpoints or configuration contents are used.
        commands.append({'command': [exe.name, *[str(a).replace(str(fixture), '<disposable-fixture>') for a in arguments]], 'exit_code': p.returncode, 'stdout': p.stdout.strip(), 'stderr': p.stderr.strip()})
        return p

    original_digest = digest(binary)
    installed = call(agent, 'install', '--state-dir', state_dir, '--vector-binary', binary, '--managed-config', managed, '--adopt')
    assert installed.returncode == 0, installed.stderr
    settings_path = state_dir / 'settings.json'
    preserved = {p: digest(p) for p in [settings_path, state_dir / 'state.json', state_dir / 'adoption-backup.json', managed]}
    assert json.loads(settings_path.read_text())['vector_binary_sha256'] == original_digest
    with binary.open('ab') as f:
        f.write(b'\nVectory explicitly synthetic same-version replacement proof\n')
    replacement_digest = digest(binary)
    assert replacement_digest != original_digest
    version = call(binary, '--version')
    assert version.returncode == 0 and version.stdout.startswith('vector 0.58.0 ')
    repeated = call(agent, 'install', '--state-dir', state_dir, '--vector-binary', binary, '--managed-config', managed, '--adopt')
    assert repeated.returncode == 0
    still_pinned = json.loads(settings_path.read_text())['vector_binary_sha256']
    doctor = call(agent, 'doctor', '--state-dir', state_dir, '--json')
    assert doctor.returncode != 0
    assert 'differs from adopted digest' in doctor.stdout + doctor.stderr
    assert still_pinned == original_digest
    assert all(digest(p) == expected for p, expected in preserved.items())
    report = {
        'recorded_at': datetime.now(timezone.utc).isoformat(), 'passed': True,
        'classification': 'expected_workflow_gap_observation', 'correctness_acceptance': False,
        'scope': 'Actual Windows CLI with a disposable copy of native Vector0.58.0. An inert PE overlay makes the same supported build a distinct candidate. Version probe only; no daemon, server, services, credentials, network or workload activation.',
        'agent': {'path': str(agent), 'sha256': digest(agent)},
        'original_vector_sha256': original_digest, 'replacement_vector_sha256': replacement_digest,
        'same_path_install_exit_zero_without_repin': True, 'doctor_refuses_changed_digest': True,
        'managed_state_settings_backup_unchanged': True, 'commands': commands,
        'fixture_path': str(fixture), 'fixture_retained': True,
        'harness_sha256': digest(Path(__file__)),
        'source_sha256': {p: digest(ROOT / p) for p in ['agent/cmd/vectory/main.go', 'agent/internal/agent/reconcile.go', 'agent/internal/agent/vector.go', 'agent/internal/agent/storage.go']},
        'limits': ['PE overlay is a synthetic same-version binary replacement, not qualification of a different upstream Vector release.', 'Doctor digest refusal is intentional protection. The observed gap is absence of an explicit validated way to approve the new identity.']
    }
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'report': str(output / 'report.json')}))


if __name__ == '__main__':
    main()
