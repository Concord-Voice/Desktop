#!/usr/bin/env python3
"""Exercise the nightly's real shell resolver and IOC handoff contract."""
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS = ROOT / '.github/workflows'
NIGHTLY = 'nightly-native-audiocap.yml'


def workflow(name=NIGHTLY):
    return yaml.safe_load((WORKFLOWS / name).read_text())


class NativeNightlyTest(unittest.TestCase):
    def test_hook_pin_guard_accepts_shas_and_rejects_movable_refs(self):
        source = (ROOT / '.pre-commit-config.yaml').read_text()
        config = yaml.safe_load(source)
        hook = next(h for repo in config['repos'] for h in repo['hooks']
                    if h['id'] == 'hook-revs-are-shas')
        self.assertEqual(hook['entry'], 'python3 scripts/check-hook-revisions.py .pre-commit-config.yaml')
        self.assertEqual(hook['language'], 'python')
        self.assertIn('PyYAML==6.0.3', hook['additional_dependencies'])
        self.assertIs(hook['pass_filenames'], False)
        for path in ('.pre-commit-config.yaml', 'scripts/check-hook-revisions.py'):
            self.assertRegex(path, hook['files'])
        pin = next(repo['rev'] for repo in config['repos'] if 'rev' in repo)
        original = next(line for line in source.splitlines() if f'rev: {pin}' in line)
        cases = [('checked-in pins', source, 0)]
        for value in ('main', 'v1.0.0', 'abc123', 'a' * 39, 'a' * 41, 'g' * 40):
            for separator in (' ', '  ', '\t'):
                cases.append((f'movable {value} {separator!r}', source.replace(
                    original, f'    rev:{separator}{value}  # frozen: v1', 1), 1))
        for label, replacement in (
            ('space before colon', '    rev : main  # frozen: v1'),
            ('missing frozen comment', f'    rev: {pin}'),
            ('empty frozen tag', f'    rev: {pin}  # frozen:'),
            ('preceding comment', f'    # frozen: v1\n    rev: {pin}'),
            ('comment decoy', f'    rev: {pin}  # unrelated frozen: v1'),
            ('duplicate rev', original + '\n' + original),
            ('alias', f'    other: &pin {pin}\n    rev: *pin  # frozen: v1'),
        ):
            cases.append((label, source.replace(original, replacement, 1), 1))
        for value in ('main', pin):
            cases.append((f'inline {value}', source + '\n  - {repo: https://example.invalid/hooks, '
                          f'rev: {value}, hooks: [{{id: test}}]}} # frozen: v1\n', 1))
        cases.extend([('invalid YAML', 'repos: [', 1), ('missing repos', '{}', 1),
                      ('non-mapping repo', 'repos: [main]', 1),
                      ('local and meta', 'repos: [{repo: local}, {repo: meta}]', 0)])
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'config.yaml'
            for label, content, expected in cases:
                with self.subTest(label=label):
                    target.write_text(content)
                    result = subprocess.run([sys.executable, str(ROOT / 'scripts/check-hook-revisions.py'),
                                             str(target)], capture_output=True, text=True, check=False)
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                    self.assertNotIn('Traceback', result.stderr)

    def test_checked_in_gate(self):
        result = subprocess.run(['bash', str(ROOT / 'scripts/check-native-ioc-gate.sh')],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_rejects_nightly_bypasses(self):
        mutations = [
            ('missing nightly', lambda d: None),
            ('missing native', lambda d: d['jobs'].pop('native-audiocap')),
            ('missing IOC', lambda d: d['jobs'].pop('ioc')),
            ('missing window', lambda d: d['jobs'].pop('window')),
            ('missing IOC dependency', lambda d: d['jobs']['native-audiocap'].pop('needs')),
            ('wrong callee', lambda d: d['jobs']['native-audiocap'].update(uses='./.github/workflows/build.yml')),
            ('missing window dependency', lambda d: d['jobs']['ioc'].pop('needs')),
            ('missing diff base', lambda d: d['jobs']['ioc'].pop('with')),
            ('last-merge-only base', lambda d: d['jobs']['ioc'].update({'with': {'diff-base': 'HEAD~1'}})),
            ('missing window output', lambda d: d['jobs']['window'].pop('outputs')),
            ('changed cadence', lambda d: d[True]['schedule'][0].update(cron='0 7 * * 1')),
            ('cancel in flight', lambda d: d['concurrency'].update({'cancel-in-progress': True})),
            ('release job added', lambda d: d['jobs'].update(release={'runs-on': 'ubuntu-latest'})),
            ('unrestricted branch', lambda d: d['jobs']['window'].pop('if')),
        ]
        for name in ('ioc', 'native-audiocap'):
            for condition in ('always()', 'false', "needs.changes.outputs.native == 'true'"):
                mutations.append((f'{name}: {condition}',
                                  lambda d, n=name, c=condition: d['jobs'][n].update({'if': c})))
            mutations.extend([
                (f'{name}: swallowed failure', lambda d, n=name: d['jobs'][n].update({'continue-on-error': True})),
                (f'{name}: write permission', lambda d, n=name: d['jobs'][n].update(permissions={'contents': 'write'})),
                (f'{name}: secrets', lambda d, n=name: d['jobs'][n].update(secrets='inherit')),
            ])
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name in ('pr-ci.yml', 'main-ci.yml', 'native-audiocap.yml'):
                shutil.copyfile(WORKFLOWS / name, target / name)
            for label, mutate in mutations:
                with self.subTest(label=label):
                    doc = copy.deepcopy(workflow())
                    mutate(doc)
                    path = target / NIGHTLY
                    if label == 'missing nightly':
                        path.unlink(missing_ok=True)
                    else:
                        path.write_text(yaml.safe_dump(doc))
                    result = subprocess.run(
                        ['bash', str(ROOT / 'scripts/check-native-ioc-gate.sh'), str(target)],
                        capture_output=True, text=True, check=False)
                    self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                    self.assertIn(NIGHTLY, result.stdout)
                    self.assertNotIn('Traceback', result.stderr)

    def test_checkout_and_ioc_input_reach_the_same_revision(self):
        window = workflow()['jobs']['window']
        checkout, resolver = window['steps']
        self.assertRegex(checkout['uses'], r'^actions/checkout@[0-9a-f]{40}$')
        self.assertEqual(checkout['with'], {'persist-credentials': False, 'fetch-depth': 0})
        self.assertEqual(resolver['id'], 'window')
        self.assertNotIn('if', resolver)
        ioc = workflow('ioc-scanning.yml')['jobs']['supply-chain-scan']
        scan = next(step for step in ioc['steps'] if step.get('id') == 'scan')
        self.assertIn("inputs.diff-base != '' && inputs.diff-base", scan['env']['IOC_DIFF_BASE'])
        for job in workflow('native-audiocap.yml')['jobs'].values():
            checkout = job['steps'][0]
            self.assertTrue(checkout['uses'].startswith('actions/checkout@'))
            self.assertNotIn('ref', checkout['with'], 'native must test the triggering SHA')

    def test_suite_is_reachable_for_its_inputs(self):
        inputs = ['.pre-commit-config.yaml', 'scripts/check-hook-revisions.py',
                  f'.github/workflows/{NIGHTLY}', '.github/workflows/ioc-scanning.yml',
                  '.github/scripts/tests/test_native_nightly.py']
        policy = yaml.safe_load((ROOT / '.github/ci/scan-relevance.yml').read_text())
        for path in inputs:
            self.assertIn(path, policy['native_ioc'])
        hooks = yaml.safe_load((ROOT / '.pre-commit-config.yaml').read_text())
        hook = next(h for repo in hooks['repos'] for h in repo['hooks']
                    if h['id'] == 'test-check-native-ioc-gate')
        for path in inputs:
            self.assertRegex(path, hook['files'])
        shell = (ROOT / 'scripts/test-check-native-ioc-gate.sh').read_text()
        self.assertIn('python3 "${ROOT}/.github/scripts/tests/test_native_nightly.py"', shell)
        self.assertIn('set -euo pipefail', shell)
        steps = workflow('pr-ci.yml')['jobs']['static-guards']['steps']
        runner = next(step for step in steps if step.get('run') == 'bash scripts/test-check-native-ioc-gate.sh')
        self.assertIn('.advisory.native_ioc', runner['if'])


class ScanWindowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
                    'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
                    'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid',
                    'GITHUB_REPOSITORY': 'Concord-Voice/Desktop', 'GITHUB_BASE_REF': '',
                    'PRE_COMMIT_FROM_REF': '', 'PRE_COMMIT_TO_REF': '',
                    'GITHUB_OUTPUT': str(self.root / 'output'), 'API_FAILURE': ''}
        self.git('init', '-q', '-b', 'main')
        self.root_sha = self.commit('root')
        self.base = self.commit('last successful nightly')
        (self.repo / 'desktop').mkdir()
        (self.repo / 'desktop/package-lock.json').write_text(json.dumps({
            'lockfileVersion': 3, 'packages': {'node_modules/nightly-fixture': {
                'version': '1.0.0', 'scripts': {'postinstall': 'echo fixture'}}}}))
        self.git('add', '.')
        self.install = self.commit('install script added early in the window')
        self.head = self.commit('later unrelated merge')
        self.git('checkout', '-q', '-b', 'other', self.root_sha)
        self.unrelated = self.commit('other branch')
        self.git('checkout', '-q', 'main')
        bindir = self.root / 'bin'
        bindir.mkdir()
        gh = bindir / 'gh'
        gh.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
from pathlib import Path
from urllib.parse import parse_qs
Path(os.environ['API_ARGS']).write_text(json.dumps(sys.argv[1:]))
if os.environ.get('API_FAILURE'):
    print('API unavailable', file=sys.stderr)
    sys.exit(1)
query = parse_qs(sys.argv[2].split('?')[1])
runs = json.loads(os.environ['RUNS'])
for key, field in [('status', 'conclusion'), ('branch', 'head_branch'), ('event', 'event')]:
    if key in query:
        runs = [run for run in runs if run[field] == query[key][0]]
print(runs[0]['head_sha'] if runs else '')
''')
        gh.chmod(0o755)
        self.env.update(PATH=f"{bindir}:{os.environ['PATH']}", API_ARGS=str(self.root / 'api-args'))
        self.script = next(step['run'] for step in workflow()['jobs']['window']['steps']
                           if step.get('id') == 'window')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, message):
        self.git('commit', '-q', '--allow-empty', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def run_record(self, sha, conclusion='success', event='schedule', branch='main'):
        return {'head_sha': sha, 'conclusion': conclusion, 'event': event, 'head_branch': branch}

    def resolve(self, runs, api_failure=False):
        output = Path(self.env['GITHUB_OUTPUT'])
        output.unlink(missing_ok=True)
        env = {**self.env, 'RUNS': json.dumps(runs), 'API_FAILURE': '1' if api_failure else ''}
        result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', self.script],
                                cwd=self.repo, env=env, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        match = re.fullmatch(r'diff-base=([0-9a-f]{40})\n', output.read_text())
        self.assertIsNotNone(match, output.read_text())
        args = json.loads(Path(self.env['API_ARGS']).read_text())
        self.assertEqual(args, ['api', 'repos/Concord-Voice/Desktop/actions/workflows/' + NIGHTLY
                               + '/runs?status=success&branch=main&event=schedule&per_page=1',
                               '--jq', '.workflow_runs[0].head_sha // ""'])
        return match[1]

    def test_failed_cancelled_manual_and_other_branch_runs_do_not_shrink_window(self):
        runs = [self.run_record(self.head, 'failure'), self.run_record(self.head, 'cancelled'),
                self.run_record(self.head, event='workflow_dispatch'),
                self.run_record(self.unrelated, branch='other'), self.run_record(self.base)]
        self.assertEqual(self.resolve(runs), self.base)

    def test_cold_start_api_error_and_unusable_history_fall_back_to_root(self):
        for sha in ('', 'f' * 40, self.unrelated, 'main', 'invalid\ndiff-base=HEAD~1'):
            with self.subTest(sha=sha):
                self.assertEqual(self.resolve([self.run_record(sha)]), self.root_sha)
        self.assertEqual(self.resolve([]), self.root_sha)
        self.assertEqual(self.resolve([self.run_record(self.base)], api_failure=True), self.root_sha)

    def test_rerun_behind_latest_success_falls_back_to_root(self):
        self.git('checkout', '-q', self.base)
        self.assertEqual(self.resolve([self.run_record(self.head)]), self.root_sha)

    def test_unchanged_main_still_emits_a_base(self):
        self.assertEqual(self.resolve([self.run_record(self.head)]), self.head)

    def test_resolved_window_exposes_install_script_missed_by_head_parent(self):
        base = self.resolve([self.run_record(self.base)])
        scanner = ROOT / 'scripts/security/scan-supply-chain-iocs.sh'
        env = {**self.env, 'IOC_DIFF_BASE': base,
               'IOC_LIST_PATH': str(ROOT / 'scripts/security/iocs/shai-hulud-2.0.txt'),
               'IOC_ALLOWLIST_PATH': str(ROOT / 'scripts/security/iocs/false-positive-allowlist.txt')}
        def scan(diff_base):
            result = subprocess.run(['bash', str(scanner), '--lockfile-only'], cwd=self.repo,
                                    env={**env, 'IOC_DIFF_BASE': diff_base}, capture_output=True,
                                    text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return result.stdout
        warning = '[WARN] New install script: nightly-fixture@1.0.0'
        self.assertIn(warning, scan(base))
        self.assertNotIn(warning, scan('HEAD~1'))
        self.assertIn(warning, scan(self.resolve([])))


if __name__ == '__main__':
    unittest.main()
