#!/usr/bin/env python3
"""Audit the complete lockfile and prove the one known optional RSA path inactive.

No scanner finding is deleted or passed to cargo-audit's --ignore option. A
release still requires reviewing the attached raw report and source dependency
inventory; this gate distinguishes unused lockfile packages from compiled code.
"""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cargo', default='cargo')
    parser.add_argument('--cargo-audit', default='cargo-audit')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    scanned = subprocess.run([args.cargo_audit, 'audit', '--file', str(ROOT/'server/Cargo.lock'), '--json'], capture_output=True, text=True, encoding='utf-8')
    try:
        audit = json.loads(scanned.stdout)
    except (ValueError, TypeError):
        raise SystemExit('cargo-audit did not produce a valid report; scanner/network failure is not a pass')
    if scanned.returncode not in (0, 1) or 'vulnerabilities' not in audit:
        raise SystemExit('cargo-audit failed; scanner/network failure is not a pass')
    active, inactive = [], []
    for item in audit['vulnerabilities'].get('list', []):
        finding = {'id': item['advisory']['id'], 'package': item['package']['name'], 'version': item['package']['version']}
        if finding == {'id': 'RUSTSEC-2023-0071', 'package': 'rsa', 'version': '0.9.10'}:
            tree = subprocess.run([args.cargo, 'tree', '--locked', '--manifest-path', str(ROOT/'server/Cargo.toml'), '--target', 'all', '--invert', 'rsa', '--prefix', 'none'], capture_output=True, text=True, encoding='utf-8')
            if tree.returncode == 0 and not tree.stdout.strip() and 'nothing to print' in tree.stderr:
                inactive.append({**finding, 'reason': 'Optional SQLx dependency is present in Cargo.lock but absent from the selected feature dependency graph for all targets.', 'proof_command': 'cargo tree --locked --manifest-path server/Cargo.toml --target all --invert rsa --prefix none', 'proof_stdout': tree.stdout, 'proof_stderr': tree.stderr})
                continue
        active.append(finding)
    # A yanked release carries no advisory: name it by package and version.
    warnings = [{'kind': kind, 'id': (item.get('advisory') or {}).get('id') or f"{kind} {item['package']['name']} {item['package']['version']}", 'package': item['package']['name']} for kind, items in audit.get('warnings', {}).items() for item in items]
    result = {'raw_audit': audit, 'active_or_unresolved_findings': active, 'proven_inactive_lockfile_findings': inactive, 'warnings_requiring_review': warnings, 'gate_passed': not active and not warnings}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k != 'raw_audit'}, indent=2))
    raise SystemExit(0 if result['gate_passed'] else 1)


if __name__ == '__main__':
    main()
