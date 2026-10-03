"""audit-npm.py against a stub npm that prints canned audit reports."""
import contextlib
from datetime import date
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('audit_npm', Path(__file__).with_name('audit-npm.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

TODAY = date(2026, 10, 3)
ADVISORY = 'GHSA-ch52-4w7c-c8xp'
OTHER = 'GHSA-aaaa-bbbb-cccc'

# The stub records where and how it was called, then prints the reply that
# the test chose for the directory it runs in.
STUB = """#!@PYTHON@
import json, sys, time
from pathlib import Path
here = Path(__file__).resolve().parent
with open(here / 'calls.log', 'a') as log:
    log.write(json.dumps([Path.cwd().name] + sys.argv[1:]) + '\\n')
reply = json.loads((here / 'replies.json').read_text())[Path.cwd().name]
time.sleep(reply.get('sleep', 0))
sys.stdout.write(reply['stdout'])
sys.exit(reply['code'])
"""


def advisory(package, ghsa=ADVISORY, severity='high'):
    """An advisory object as npm prints it in the `via` list of the package the advisory is about."""
    return {'source': 1240991, 'name': package, 'dependency': package, 'title': f'{package} has a flaw', 'url': f'https://github.com/advisories/{ghsa}', 'severity': severity, 'cwe': ['CWE-524'], 'cvss': {'score': 7.5, 'vectorString': 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'}, 'range': '<=4.2.0'}


def entry(name, severity, *via, effects=()):
    """A package's entry: its own advisories, and the names of the vulnerable packages it depends on."""
    return {'name': name, 'severity': severity, 'isDirect': False, 'via': list(via), 'effects': list(effects), 'range': '*', 'nodes': [f'node_modules/{name}'], 'fixAvailable': False}


def report(*entries):
    return {'auditReportVersion': 2, 'vulnerabilities': {e['name']: e for e in entries}, 'metadata': {'vulnerabilities': {'total': len(entries)}}}


def chain(ghsa=ADVISORY, severity='high'):
    """The shape npm printed for the help center: the package with the advisory, and four that are flagged only because they depend on it."""
    return report(
        entry('http-cache-semantics', severity, advisory('http-cache-semantics', ghsa, severity), effects=['astro']),
        entry('astro', severity, 'http-cache-semantics', effects=['@astrojs/mdx', '@astrojs/starlight', 'astro-expressive-code']),
        entry('@astrojs/mdx', severity, 'astro', effects=['@astrojs/starlight']),
        entry('astro-expressive-code', severity, 'astro', effects=['@astrojs/starlight']),
        entry('@astrojs/starlight', severity, '@astrojs/mdx', 'astro', 'astro-expressive-code'),
    )


def single(package, ghsa=OTHER, severity='high'):
    return report(entry(package, severity, advisory(package, ghsa, severity)))


def exception(**changes):
    return {'directory': 'help-center', 'advisory': ADVISORY, 'package': 'http-cache-semantics', 'reason': 'Only the build uses it.', 'expires': '2026-12-31', **changes}


@unittest.skipIf(os.name == 'nt', 'the stub npm is a script with a shebang line')
class Gate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in (*audit.DIRECTORIES, 'bin'):
            (self.root / name).mkdir()
        self.npm = self.root / 'bin' / 'npm'
        self.npm.write_text(STUB.replace('@PYTHON@', sys.executable), encoding='utf-8')
        self.npm.chmod(0o755)
        self.exceptions = self.root / 'exceptions.json'
        self.out = self.root / 'artifacts' / 'npm-dependency-audit.json'
        self.replies = {directory: {'stdout': json.dumps(report()), 'code': 0} for directory in audit.DIRECTORIES}
        self.excuse()

    def reply(self, directory, document=None, *, stdout=None, code=0, sleep=0):
        self.replies[directory] = {'stdout': json.dumps(document) if stdout is None else stdout, 'code': code, 'sleep': sleep}

    def excuse(self, *entries):
        self.exceptions.write_text(json.dumps(list(entries)), encoding='utf-8')

    def publish_replies(self):
        (self.root / 'bin' / 'replies.json').write_text(json.dumps(self.replies), encoding='utf-8')

    def run_gate(self, today=TODAY, **environment):
        """Returns how the gate ended and what it printed: 0 when it returned, else the SystemExit code (1, or the message of a refusal)."""
        self.publish_replies()
        arguments = ['--npm', str(self.npm), '--root', str(self.root), '--exceptions', str(self.exceptions), '--out', str(self.out)]
        printed = io.StringIO()
        # A run on GitHub Actions must not annotate or summarize for these tests' sake.
        environment = {'GITHUB_ACTIONS': '', 'GITHUB_STEP_SUMMARY': '', **environment}
        with mock.patch.dict(os.environ, environment), contextlib.redirect_stdout(printed):
            try:
                audit.main(arguments, today=today)
            except SystemExit as stopped:
                return stopped.code, printed.getvalue()
        return 0, printed.getvalue()

    def written(self):
        return json.loads(self.out.read_text(encoding='utf-8'))

    def test_a_clean_tree_passes(self):
        code, printed = self.run_gate()
        self.assertEqual(code, 0)
        result = self.written()
        self.assertTrue(result['gate_passed'])
        self.assertEqual((result['acknowledged_findings'], result['active_findings'], result['expired_exceptions'], result['stale_exceptions']), ([], [], [], []))
        self.assertIn('dashboard: no high or critical advisory\nhelp-center: no high or critical advisory\n', printed)
        self.assertTrue(printed.endswith('Passed: no unacknowledged high or critical advisory.\n'))

    def test_npm_audit_runs_for_the_shipped_dependencies_of_each_directory(self):
        self.run_gate()
        calls = [json.loads(line) for line in (self.root / 'bin' / 'calls.log').read_text(encoding='utf-8').splitlines()]
        self.assertEqual(calls, [['dashboard', 'audit', '--omit=dev', '--json'], ['help-center', 'audit', '--omit=dev', '--json']])

    def test_a_high_finding_fails(self):
        self.reply('dashboard', single('left-pad', severity='high'))
        code, printed = self.run_gate()
        self.assertEqual(code, 1)
        result = self.written()
        self.assertFalse(result['gate_passed'])
        self.assertEqual([(f['directory'], f['advisory'], f['package'], f['severity']) for f in result['active_findings']], [('dashboard', OTHER, 'left-pad', 'high')])
        self.assertIn(f'FAIL: dashboard: {OTHER} (high) in left-pad is not acknowledged.', printed)
        self.assertTrue(printed.endswith('Failed: 1 problem(s).\n'))

    def test_a_critical_finding_fails(self):
        self.reply('help-center', single('left-pad', severity='critical'))
        code, _ = self.run_gate()
        self.assertEqual(code, 1)
        self.assertEqual([f['severity'] for f in self.written()['active_findings']], ['critical'])

    def test_a_moderate_finding_does_not_fail(self):
        self.reply('dashboard', report(entry('left-pad', 'moderate', advisory('left-pad', OTHER, 'moderate')), entry('right-pad', 'low', advisory('right-pad', 'GHSA-dddd-eeee-ffff', 'low'))))
        code, printed = self.run_gate()
        self.assertEqual(code, 0)
        self.assertEqual(self.written()['active_findings'], [])
        self.assertIn('dashboard: no high or critical advisory (2 below high, not gated)', printed)

    def test_the_excepted_finding_passes_and_is_kept_with_its_reason(self):
        self.reply('help-center', chain())
        self.excuse(exception())
        code, printed = self.run_gate()
        self.assertEqual(code, 0)
        result = self.written()
        self.assertTrue(result['gate_passed'])
        self.assertEqual(result['active_findings'], [])
        [finding] = result['acknowledged_findings']
        self.assertEqual((finding['directory'], finding['advisory'], finding['package'], finding['severity']), ('help-center', ADVISORY, 'http-cache-semantics', 'high'))
        self.assertEqual((finding['reason'], finding['expires']), ('Only the build uses it.', '2026-12-31'))
        self.assertIn(f'{ADVISORY}  http-cache-semantics  high  acknowledged until 2026-12-31', printed)

    def test_no_finding_is_deleted_from_the_raw_report(self):
        self.reply('dashboard', report(entry('left-pad', 'moderate', advisory('left-pad', OTHER, 'moderate'))))
        self.reply('help-center', chain())
        self.excuse(exception())
        self.run_gate()
        raw = self.written()['raw_audit']
        self.assertEqual(raw, {'dashboard': json.loads(self.replies['dashboard']['stdout']), 'help-center': json.loads(self.replies['help-center']['stdout'])})
        self.assertEqual(len(raw['help-center']['vulnerabilities']), 5)

    def test_the_same_advisory_in_the_other_directory_is_not_excused(self):
        self.reply('help-center', chain())
        self.reply('dashboard', chain())
        self.excuse(exception())
        code, _ = self.run_gate()
        self.assertEqual(code, 1)
        result = self.written()
        self.assertEqual([f['directory'] for f in result['active_findings']], ['dashboard'])
        self.assertEqual([f['directory'] for f in result['acknowledged_findings']], ['help-center'])

    def test_a_different_advisory_for_the_same_package_is_not_excused(self):
        self.reply('help-center', chain(ghsa=OTHER))
        self.excuse(exception())
        code, _ = self.run_gate()
        self.assertEqual(code, 1)
        self.assertEqual([(f['advisory'], f['package']) for f in self.written()['active_findings']], [(OTHER, 'http-cache-semantics')])
        self.assertEqual([e['advisory'] for e in self.written()['stale_exceptions']], [ADVISORY])

    def test_the_same_advisory_in_a_different_package_is_not_excused(self):
        self.reply('help-center', single('other-cache', ghsa=ADVISORY))
        self.excuse(exception())
        code, _ = self.run_gate()
        self.assertEqual(code, 1)
        self.assertEqual([(f['advisory'], f['package']) for f in self.written()['active_findings']], [(ADVISORY, 'other-cache')])

    def test_an_expired_exception_fails_and_excuses_nothing(self):
        self.reply('help-center', chain())
        self.excuse(exception(expires='2026-12-31'))
        code, printed = self.run_gate(today=date(2027, 1, 1))
        self.assertEqual(code, 1)
        result = self.written()
        self.assertEqual([f['advisory'] for f in result['active_findings']], [ADVISORY])
        self.assertEqual([e['expires'] for e in result['expired_exceptions']], ['2026-12-31'])
        self.assertIn('expired on 2026-12-31', printed)

    def test_an_exception_holds_through_its_last_day(self):
        self.reply('help-center', chain())
        self.excuse(exception(expires='2026-12-31'))
        self.assertEqual(self.run_gate(today=date(2026, 12, 31))[0], 0)
        self.assertEqual(self.run_gate(today=date(2027, 1, 1))[0], 1)

    def test_an_expired_exception_fails_even_when_its_advisory_is_gone(self):
        self.excuse(exception(expires='2026-12-31'))
        code, _ = self.run_gate(today=date(2027, 1, 1))
        self.assertEqual(code, 1)
        result = self.written()
        self.assertEqual(result['active_findings'], [])
        self.assertEqual(len(result['expired_exceptions']), 1)
        self.assertEqual(result['stale_exceptions'], [])

    def test_a_stale_exception_is_reported_and_does_not_fail(self):
        self.excuse(exception())
        code, printed = self.run_gate()
        self.assertEqual(code, 0)
        result = self.written()
        self.assertTrue(result['gate_passed'])
        self.assertEqual([e['advisory'] for e in result['stale_exceptions']], [ADVISORY])
        self.assertIn(f'WARNING: exceptions.json: the exception for {ADVISORY} in http-cache-semantics (help-center) matches no advisory now.', printed)

    def test_an_advisory_reached_through_a_chain_is_judged_by_its_root(self):
        flagged = chain()
        self.assertEqual(len([e for e in flagged['vulnerabilities'].values() if e['severity'] == 'high']), 5)
        self.reply('help-center', flagged)
        code, printed = self.run_gate()
        self.assertEqual(code, 1)
        # npm flags five packages; one advisory is the cause, so one finding.
        self.assertEqual([(f['package'], f['advisory']) for f in self.written()['active_findings']], [('http-cache-semantics', ADVISORY)])
        self.assertIn('help-center: 1 high or critical advisory\n', printed)
        # Excusing the root excuses the packages that depend on it, and nothing else.
        self.excuse(exception())
        self.assertEqual(self.run_gate()[0], 0)
        self.assertEqual([f['package'] for f in self.written()['acknowledged_findings']], ['http-cache-semantics'])
        self.assertEqual(self.written()['active_findings'], [])

    def test_a_dependent_with_an_advisory_of_its_own_is_judged_on_its_own(self):
        flagged = chain()
        flagged['vulnerabilities']['astro']['via'].append(advisory('astro', OTHER, 'high'))
        self.reply('help-center', flagged)
        self.excuse(exception())
        code, _ = self.run_gate()
        self.assertEqual(code, 1)
        self.assertEqual([(f['package'], f['advisory']) for f in self.written()['active_findings']], [('astro', OTHER)])
        self.assertEqual([f['package'] for f in self.written()['acknowledged_findings']], ['http-cache-semantics'])

    def test_a_package_flagged_without_an_advisory_behind_it_fails(self):
        self.reply('help-center', report(entry('astro', 'high', 'http-cache-semantics')))
        code, _ = self.run_gate()
        self.assertIn('no high or critical advisory is behind it', code)
        self.reply('help-center', report(entry('astro', 'high', 'moderate-one'), entry('moderate-one', 'moderate', advisory('moderate-one', OTHER, 'moderate'))))
        code, _ = self.run_gate()
        self.assertIn('no high or critical advisory is behind it', code)
        # Packages that name each other end the search, not the gate.
        self.reply('help-center', report(entry('a', 'high', 'b'), entry('b', 'high', 'a')))
        code, _ = self.run_gate()
        self.assertIn('no high or critical advisory is behind it', code)

    def test_an_exception_names_the_package_that_has_the_advisory_not_one_that_depends_on_it(self):
        self.reply('help-center', chain())
        self.excuse(exception(package='astro'))
        code, _ = self.run_gate()
        self.assertEqual(code, 1)
        result = self.written()
        self.assertEqual([f['package'] for f in result['active_findings']], ['http-cache-semantics'])
        self.assertEqual([e['package'] for e in result['stale_exceptions']], ['astro'])

    def test_an_advisory_that_names_no_ghsa_id_is_never_excused(self):
        unnamed = advisory('left-pad')
        unnamed['url'] = 'https://example.org/advisories/1234'
        self.reply('dashboard', report(entry('left-pad', 'high', unnamed)))
        self.excuse(exception(directory='dashboard', advisory=OTHER, package='left-pad'))
        code, _ = self.run_gate()
        self.assertEqual(code, 1)
        self.assertEqual([f['advisory'] for f in self.written()['active_findings']], ['https://example.org/advisories/1234'])
        del unnamed['url']
        self.reply('dashboard', report(entry('left-pad', 'high', unnamed)))
        self.run_gate()
        self.assertEqual([f['advisory'] for f in self.written()['active_findings']], ['npm advisory 1240991'])

    def test_output_that_is_not_json_fails(self):
        for text in ('not json', '{"truncated": ', '<html>502 Bad Gateway</html>'):
            self.reply('help-center', stdout=text, code=0)
            code, _ = self.run_gate()
            self.assertIn('help-center: npm audit --omit=dev --json printed no JSON report', code)
            self.assertIn('scanner or network failure is not a pass', code)

    def test_json_that_is_not_an_audit_report_fails(self):
        for document in ([], 'text', {}, {'vulnerabilities': {}}, {'auditReportVersion': 1, 'advisories': {}}, {'auditReportVersion': 2, 'vulnerabilities': []}):
            self.reply('dashboard', document)
            code, _ = self.run_gate()
            self.assertIn('cannot be judged', code, document)

    def test_an_npm_that_exits_other_than_0_or_1_fails(self):
        for status in (2, 127, 255):
            self.reply('dashboard', report(), code=status)
            code, _ = self.run_gate()
            self.assertIn(f'dashboard: npm audit --omit=dev --json exited {status}', code)

    def test_an_npm_that_prints_nothing_fails(self):
        for status in (0, 1):
            self.reply('help-center', stdout='', code=status)
            code, _ = self.run_gate()
            self.assertIn('printed no JSON report', code)

    def test_an_error_that_npm_prints_as_json_fails_even_though_it_exits_1(self):
        no_lockfile = {'error': {'code': 'ENOLOCK', 'summary': 'This command requires an existing lockfile.', 'detail': 'Try creating one first with: npm i --package-lock-only'}}
        unreachable = {'message': 'request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org', 'error': {'summary': '', 'detail': ''}}
        for document, said in ((no_lockfile, 'This command requires an existing lockfile.'), (unreachable, 'getaddrinfo ENOTFOUND registry.npmjs.org')):
            self.reply('help-center', document, code=1)
            code, _ = self.run_gate()
            self.assertIn('npm reported an error', code)
            self.assertIn(said, code)

    def test_a_report_with_an_advisory_that_cannot_be_read_fails(self):
        for broken in ({**advisory('left-pad'), 'severity': 'urgent'}, {**advisory('left-pad'), 'name': None}):
            self.reply('dashboard', report(entry('left-pad', 'high', broken)))
            code, _ = self.run_gate()
            self.assertIn('an advisory of left-pad is malformed', code)

    def test_an_npm_that_cannot_run_fails(self):
        self.npm.unlink()
        code, _ = self.run_gate()
        self.assertIn('dashboard: npm audit --omit=dev --json did not finish', code)

    def test_an_npm_that_hangs_fails(self):
        self.reply('dashboard', report(), sleep=5)
        with mock.patch.object(audit, 'TIMEOUT_SECONDS', 1):
            code, _ = self.run_gate()
        self.assertIn('did not finish', code)
        self.assertIn('timed out', code)

    def test_a_failed_scan_leaves_no_report_from_an_earlier_run(self):
        self.out.parent.mkdir(parents=True)
        self.out.write_text('{"gate_passed": true}', encoding='utf-8')
        self.reply('help-center', stdout='', code=2)
        code, _ = self.run_gate()
        self.assertIn('exited 2', code)
        self.assertFalse(self.out.exists())

    def test_a_malformed_exceptions_file_fails_before_npm_runs(self):
        cases = {
            'not json': ('{', 'cannot be read'),
            'not a list': (json.dumps({'directory': 'help-center'}), 'must be a list'),
            'a missing field': (json.dumps([{k: v for k, v in exception().items() if k != 'reason'}]), 'must have exactly the fields'),
            'an extra field': (json.dumps([{**exception(), 'severity': 'high'}]), 'must have exactly the fields'),
            'an empty reason': (json.dumps([exception(reason=' ')]), 'empty or not text'),
            'a field that is not text': (json.dumps([exception(package=None)]), 'empty or not text'),
            'an unknown directory': (json.dumps([exception(directory='server')]), 'has a directory that is not dashboard or help-center'),
            'an advisory that is not a GHSA id': (json.dumps([exception(advisory='CVE-2025-0001')]), 'must name its advisory by GHSA id'),
            'a date in another format': (json.dumps([exception(expires='31/12/2026')]), 'YYYY-MM-DD'),
            'a compact date': (json.dumps([exception(expires='20261231')]), 'YYYY-MM-DD'),
            'a date in other digits': (json.dumps([exception(expires='٢٠٢٦-١٢-٣١')]), 'YYYY-MM-DD'),
            'a date that does not exist': (json.dumps([exception(expires='2026-02-30')]), 'YYYY-MM-DD'),
            'a repeat': (json.dumps([exception(), exception(reason='Again.')]), 'repeats an earlier exception'),
        }
        for name, (text, said) in cases.items():
            with self.subTest(name):
                self.exceptions.write_text(text, encoding='utf-8')
                code, _ = self.run_gate()
                self.assertIn(said, code)
                self.assertIn('exceptions.json', code)
                self.assertFalse((self.root / 'bin' / 'calls.log').exists())

    def test_a_missing_exceptions_file_fails(self):
        self.exceptions.unlink()
        code, _ = self.run_gate()
        self.assertIn('cannot be read', code)

    def test_text_from_npm_cannot_start_a_workflow_command_in_the_log(self):
        forged = '::error::forged\n::stop-commands::token\r\n  ::add-mask::secret'
        hostile = advisory('http-cache-semantics')
        hostile['title'] = forged
        self.reply('help-center', report(entry('http-cache-semantics', 'high', hostile)))
        self.excuse(exception())
        code, printed = self.run_gate(GITHUB_ACTIONS='true')
        self.assertEqual(code, 0)
        self.assertEqual([line for line in printed.splitlines() if line.lstrip().startswith('::')], [])
        self.assertIn('"::error::forged ::stop-commands::token ::add-mask::secret"', printed)
        self.reply('help-center', {'message': forged, 'error': {'summary': '', 'detail': ''}}, code=1)
        code, _ = self.run_gate(GITHUB_ACTIONS='true')
        self.assertNotIn('\n', code)
        self.assertIn('(::error::forged ::stop-commands::token ::add-mask::secret)', code)

    def test_the_step_summary_has_a_table_of_the_findings(self):
        summary = self.root / 'summary.md'
        self.reply('help-center', chain())
        self.excuse(exception())
        self.assertEqual(self.run_gate(GITHUB_STEP_SUMMARY=str(summary))[0], 0)
        text = summary.read_text(encoding='utf-8')
        self.assertIn('| Directory | Advisory | Package | Severity | Status |', text)
        link = f'[{ADVISORY}](https://github.com/advisories/{ADVISORY})'
        self.assertIn(f'| `help-center` | {link} | `http-cache-semantics` | high | Acknowledged until 2026-12-31 |', text)
        self.assertIn('**Passed.**', text)
        self.excuse()
        self.assertEqual(self.run_gate(GITHUB_STEP_SUMMARY=str(summary))[0], 1)
        text = summary.read_text(encoding='utf-8')
        self.assertIn(f'| `help-center` | {link} | `http-cache-semantics` | high | **Not acknowledged** |', text)
        self.assertIn('**1 problem(s)**, listed in the step log.', text)

    def test_a_clean_step_summary_says_so(self):
        summary = self.root / 'summary.md'
        self.run_gate(GITHUB_STEP_SUMMARY=str(summary))
        self.assertIn('None in `dashboard` or `help-center`.', summary.read_text(encoding='utf-8'))

    def test_problems_are_annotations_on_github_actions_and_plain_lines_elsewhere(self):
        self.reply('help-center', chain())
        self.assertIn('::error::help-center:', self.run_gate(GITHUB_ACTIONS='true')[1])
        self.assertIn('FAIL: help-center:', self.run_gate(GITHUB_ACTIONS='false')[1])


    def test_the_script_exits_0_for_a_pass_and_1_for_every_failure_when_run_as_a_program(self):
        environment = {**os.environ, 'GITHUB_ACTIONS': '', 'GITHUB_STEP_SUMMARY': ''}

        def run_program():
            self.publish_replies()
            return subprocess.run([sys.executable, str(Path(audit.__file__)), '--npm', str(self.npm), '--root', str(self.root), '--exceptions', str(self.exceptions), '--out', str(self.out)], capture_output=True, text=True, env=environment)

        passed = run_program()
        self.assertEqual((passed.returncode, passed.stderr), (0, ''))
        self.reply('help-center', chain())
        failed = run_program()
        self.assertEqual(failed.returncode, 1)
        self.assertIn('FAIL: help-center:', failed.stdout)
        self.reply('help-center', report(), code=2)
        refused = run_program()
        self.assertEqual(refused.returncode, 1)
        self.assertIn('help-center: npm audit --omit=dev --json exited 2', refused.stderr)


class RepositoryExceptions(unittest.TestCase):
    def test_the_exceptions_file_in_the_repository_is_well_formed(self):
        # A typo in the real file would otherwise show only when the release gate runs.
        audit.load_exceptions(Path(__file__).with_name('npm-audit-exceptions.json'))


if __name__ == '__main__':
    unittest.main()
