#!/usr/bin/env python3
"""Audit the npm dependencies that ship and fail on any unacknowledged high or critical advisory.

Runs `npm audit --omit=dev --json` in dashboard/ and help-center/ and judges the
advisories themselves: a package that npm flags only because it depends on a
vulnerable package is covered by that package's advisory. An entry in
npm-audit-exceptions.json acknowledges one advisory in one package of one
directory until a date, and nothing else; an expired entry fails the gate. Each
raw report stays whole in --out, and a scanner or network failure is not a pass.
"""
import argparse
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DIRECTORIES = ('dashboard', 'help-center')
ARGUMENTS = ('audit', '--omit=dev', '--json')
# Both scans fit in the ten minutes of the workflow step that runs them.
TIMEOUT_SECONDS = 240
SEVERITIES = ('info', 'low', 'moderate', 'high', 'critical')
BLOCKING = ('high', 'critical')
FIELDS = ('directory', 'advisory', 'package', 'reason', 'expires')
GHSA = re.compile(r'GHSA(-[0-9a-z]{4}){3}')
ISO_DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
NOT_A_PASS = 'scanner or network failure is not a pass'


def plain(text, limit=300):
    """Text that comes from npm or an advisory, as one short printable line. A line break could start a workflow command in the log."""
    line = ' '.join(''.join(c if c.isprintable() else ' ' for c in str(text)).split())
    return line if len(line) <= limit else line[:limit - 1] + '…'


def behind(vulnerabilities, name):
    """The advisories behind a package: its own and those of the vulnerable packages it depends on."""
    found, seen, todo = [], set(), [name]
    while todo:
        current = todo.pop()
        if current in seen or current not in vulnerabilities:
            continue
        seen.add(current)
        for via in vulnerabilities[current]['via']:
            if isinstance(via, dict):
                found.append(via)
            else:
                todo.append(via)
    return found


def unusable(report):
    """Why a report cannot be judged, or None. npm prints an error as JSON too, and exits 1 for it."""
    if not isinstance(report, dict):
        return 'its output is not a JSON object'
    if 'error' in report:
        error = report['error'] if isinstance(report['error'], dict) else {}
        return f'npm reported an error ({plain(report.get("message") or error.get("summary") or error.get("code") or "no reason given")})'
    vulnerabilities = report.get('vulnerabilities')
    if report.get('auditReportVersion') != 2 or not isinstance(vulnerabilities, dict):
        return 'its output is not an npm audit report of version 2'
    for name, entry in vulnerabilities.items():
        if not isinstance(entry, dict) or entry.get('severity') not in SEVERITIES or not isinstance(entry.get('via'), list):
            return f'the entry for {plain(name)} is malformed'
        for via in entry['via']:
            if isinstance(via, dict):
                if not isinstance(via.get('name'), str) or via.get('severity') not in SEVERITIES:
                    return f'an advisory of {plain(name)} is malformed'
            elif not isinstance(via, str):
                return f'the entry for {plain(name)} names something that is neither a package nor an advisory'
    for name, entry in vulnerabilities.items():
        if entry['severity'] in BLOCKING and not any(via['severity'] in BLOCKING for via in behind(vulnerabilities, name)):
            return f'{plain(name)} is {entry["severity"]}, but no high or critical advisory is behind it'
    return None


def scan(npm, root, directory):
    """The parsed report of `npm audit` in one directory. Anything short of a complete report is a failure."""
    shown = ' '.join(('npm',) + ARGUMENTS)
    try:
        run = subprocess.run([shutil.which(npm) or npm, *ARGUMENTS], cwd=root / directory, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SystemExit(f'{directory}: {shown} did not finish ({error}); {NOT_A_PASS}')
    said = plain(run.stderr)
    said = f' ({said})' if said else ''
    if run.returncode not in (0, 1):
        raise SystemExit(f'{directory}: {shown} exited {run.returncode}{said}; {NOT_A_PASS}')
    try:
        report = json.loads(run.stdout)
    except ValueError:
        raise SystemExit(f'{directory}: {shown} printed no JSON report{said}; {NOT_A_PASS}')
    problem = unusable(report)
    if problem:
        raise SystemExit(f'{directory}: {shown} gave a report that cannot be judged: {problem}{said}; {NOT_A_PASS}')
    return report


def advisory_id(via):
    """The GHSA id npm links an advisory by. An advisory with no such link is named by what npm gave."""
    link = str(via.get('url') or '')
    last = link.rstrip('/').rsplit('/', 1)[-1]
    return last if GHSA.fullmatch(last) else link or f'npm advisory {via.get("source")}'


def advisories(report):
    """Every advisory object in a report, once per advisory and package, whichever package lists it."""
    found = {}
    for entry in report['vulnerabilities'].values():
        for via in entry['via']:
            if not isinstance(via, dict):
                continue
            finding = {'advisory': plain(advisory_id(via)), 'package': plain(via['name']), 'severity': via['severity'], 'title': plain(via['title']) if via.get('title') else None, 'url': via.get('url'), 'range': via.get('range')}
            key = (finding['advisory'], finding['package'])
            if key not in found or SEVERITIES.index(finding['severity']) > SEVERITIES.index(found[key]['severity']):
                found[key] = finding
    return sorted(found.values(), key=lambda f: (f['package'], f['advisory']))


def load_exceptions(path):
    """The acknowledgements in the exceptions file. A file that cannot be read in full is a failure, never an empty list."""
    try:
        entries = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise SystemExit(f'{path.name} cannot be read: {error}')
    if not isinstance(entries, list):
        raise SystemExit(f'{path.name} must be a list of exceptions')
    seen = set()
    for number, entry in enumerate(entries, 1):
        label = f'{path.name}: exception {number}'
        if not isinstance(entry, dict) or sorted(entry) != sorted(FIELDS):
            raise SystemExit(f'{label} must have exactly the fields {", ".join(FIELDS)}')
        if not all(isinstance(value, str) and value.strip() for value in entry.values()):
            raise SystemExit(f'{label} has a field that is empty or not text')
        if entry['directory'] not in DIRECTORIES:
            raise SystemExit(f'{label} has a directory that is not {" or ".join(DIRECTORIES)}')
        if not GHSA.fullmatch(entry['advisory']):
            raise SystemExit(f'{label} must name its advisory by GHSA id, as in GHSA-ch52-4w7c-c8xp')
        try:
            if not ISO_DATE.fullmatch(entry['expires']):
                raise ValueError
            date.fromisoformat(entry['expires'])
        except ValueError:
            raise SystemExit(f'{label} must write expires as a date, YYYY-MM-DD')
        key = (entry['directory'], entry['advisory'], entry['package'])
        if key in seen:
            raise SystemExit(f'{label} repeats an earlier exception for the same directory, advisory and package')
        seen.add(key)
    return entries


def judge(findings, exceptions, today):
    """Split the high and critical findings into acknowledged and active, and find the exceptions to review.

    An exception that has not expired excuses exactly its directory, advisory and
    package. Dates are YYYY-MM-DD, which sort as text. An exception that expired
    excuses nothing and is returned for review whether or not the advisory is still
    present; one that matches no advisory is stale, a warning only.
    """
    now = today.isoformat()
    in_force = {(e['directory'], e['advisory'], e['package']): e for e in exceptions if e['expires'] >= now}
    acknowledged, active, used = [], [], set()
    for directory in DIRECTORIES:
        for finding in findings[directory]:
            if finding['severity'] not in BLOCKING:
                continue
            record = {'directory': directory, **finding}
            key = (directory, finding['advisory'], finding['package'])
            if key in in_force:
                used.add(key)
                acknowledged.append({**record, 'reason': in_force[key]['reason'], 'expires': in_force[key]['expires']})
            else:
                active.append(record)
    expired = [e for e in exceptions if e['expires'] < now]
    stale = [e for key, e in in_force.items() if key not in used]
    return acknowledged, active, expired, stale


def named(path, root):
    """A path as a reader finds it: from the checkout's root when it lies inside."""
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)


def cell(text):
    return plain(text).replace('|', '/').replace('`', "'")


def advisory_cell(advisory):
    return f'[{advisory}](https://github.com/advisories/{advisory})' if GHSA.fullmatch(advisory) else cell(advisory)


def step_summary(result):
    """A short Markdown table for the GitHub step summary."""
    rows = [f'| `{cell(f["directory"])}` | {advisory_cell(f["advisory"])} | `{cell(f["package"])}` | {f["severity"]} | Acknowledged until {f["expires"]} |' for f in result['acknowledged_findings']]
    rows += [f'| `{cell(f["directory"])}` | {advisory_cell(f["advisory"])} | `{cell(f["package"])}` | {f["severity"]} | **Not acknowledged** |' for f in result['active_findings']]
    names = ' or '.join(f'`{directory}`' for directory in DIRECTORIES)
    problems = len(result['active_findings']) + len(result['expired_exceptions'])
    return '\n'.join([
        '### npm advisories of high or critical severity',
        '',
        *(['| Directory | Advisory | Package | Severity | Status |', '| --- | --- | --- | --- | --- |', *rows] if rows else [f'None in {names}.']),
        '',
        f'**{problems} problem(s)**, listed in the step log.' if problems else '**Passed.**',
        '',
        '',
    ])


def report_on(result, exceptions_name, reports):
    """Print the gate's verdict and add it to the GitHub step summary."""
    actions = os.environ.get('GITHUB_ACTIONS') == 'true'
    print(f'npm advisory gate, judged on {result["checked_on"]}')
    for directory in DIRECTORIES:
        mine = [(f, f'acknowledged until {f["expires"]}') for f in result['acknowledged_findings'] if f['directory'] == directory]
        mine += [(f, 'not acknowledged') for f in result['active_findings'] if f['directory'] == directory]
        below = sum(1 for f in advisories(reports[directory]) if f['severity'] not in BLOCKING)
        count = f'{len(mine)} high or critical advisor{"y" if len(mine) == 1 else "ies"}' if mine else 'no high or critical advisory'
        print(f'{directory}: {count}' + (f' ({below} below high, not gated)' if below else ''))
        for finding, status in mine:
            print(f'  {finding["advisory"]}  {finding["package"]}  {finding["severity"]}  {status}')
            if finding['title']:
                print(f'    "{finding["title"]}"')
    problems = [f'{f["directory"]}: {f["advisory"]} ({f["severity"]}) in {f["package"]} is not acknowledged. Update the package, or record in {exceptions_name} why nothing shipped is affected.' for f in result['active_findings']]
    problems += [f'{exceptions_name}: the exception for {e["advisory"]} in {e["package"]} ({e["directory"]}) expired on {e["expires"]}. Review it, then renew it with a new date or delete it.' for e in result['expired_exceptions']]
    warnings = [f'{exceptions_name}: the exception for {e["advisory"]} in {e["package"]} ({e["directory"]}) matches no advisory now. Delete it.' for e in result['stale_exceptions']]
    for warning in warnings:
        print(f'{"::warning::" if actions else "WARNING: "}{warning}')
    for problem in problems:
        print(f'{"::error::" if actions else "FAIL: "}{problem}')
    print(f'Failed: {len(problems)} problem(s).' if problems else 'Passed: no unacknowledged high or critical advisory.')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write(step_summary(result))


def main(argv=None, today=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--npm', default='npm', help='the npm executable (default: npm)')
    parser.add_argument('--out', type=Path, required=True, help='the JSON report: both raw audits, the findings and the exceptions')
    parser.add_argument('--root', type=Path, default=ROOT, help='the checkout whose dashboard/ and help-center/ are audited')
    parser.add_argument('--exceptions', type=Path, default=Path(__file__).with_name('npm-audit-exceptions.json'))
    args = parser.parse_args(argv)
    today = today or datetime.now(timezone.utc).date()
    # A report left by an earlier run must not outlive a run that fails.
    args.out.unlink(missing_ok=True)
    exceptions = load_exceptions(args.exceptions)
    reports = {directory: scan(args.npm, args.root, directory) for directory in DIRECTORIES}
    acknowledged, active, expired, stale = judge({directory: advisories(report) for directory, report in reports.items()}, exceptions, today)
    result = {
        'checked_on': today.isoformat(),
        'command': ' '.join(('npm',) + ARGUMENTS),
        'raw_audit': reports,
        'acknowledged_findings': acknowledged,
        'active_findings': active,
        'expired_exceptions': expired,
        'stale_exceptions': stale,
        'gate_passed': not active and not expired,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    report_on(result, named(args.exceptions, args.root), reports)
    if not result['gate_passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
