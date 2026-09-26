#!/usr/bin/env python3
"""Record local source bytes, without claiming a signed build attestation."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'artifacts/releases/SOURCE-INPUTS.json')
    args = parser.parse_args()
    output = args.out.resolve()
    listed = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
                            cwd=ROOT, check=True, capture_output=True).stdout
    files = []
    for name in sorted(set(n.decode('utf-8') for n in listed.split(b'\0') if n)):
        file = ROOT / name
        if name.startswith('docs/evidence/') or file.resolve() == output:
            continue
        if file.is_symlink() or not file.is_file():
            raise SystemExit('Source input is not a regular file: ' + name)
        content = file.read_bytes()
        files.append({'path': name, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
    canonical = json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    report = {
        'recorded_at': datetime.now(timezone.utc).isoformat(),
        'scope': 'Git-listed tracked and nonignored untracked regular repository files, excluding docs/evidence generated reports and this output. Ignored private fixtures/build outputs are excluded.',
        'signed': False,
        'provenance_claim': 'Local byte inventory only; not an independent build or signed provenance attestation.',
        'canonical_file_inventory_sha256': hashlib.sha256(canonical).hexdigest(),
        'files': files,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'Recorded {len(files)} local source inputs: {report["canonical_file_inventory_sha256"]}')


if __name__ == '__main__':
    main()
