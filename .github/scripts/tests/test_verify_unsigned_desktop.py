#!/usr/bin/env python3
"""Exercise the actual unsigned lane and fail-closed privilege boundaries."""
import importlib.util
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('unsigned', ROOT / '.github/scripts/verify-unsigned-desktop.py')
unsigned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unsigned)


class UnsignedDesktopTest(unittest.TestCase):
    def test_checked_in_workflows(self):
        unsigned.verify(ROOT)

    def test_version_extraction_parses_data_without_executing_symlink_target(self):
        workflow = yaml.load(
            (ROOT / '.github/workflows/build-desktop.yml').read_text(),
            Loader=yaml.BaseLoader,
        )
        step = next(step for step in workflow['jobs']['detect-release']['steps']
                    if step.get('id') == 'check')
        commands = [line for line in step['run'].splitlines()
                    if line.startswith('VERSION=')]
        self.assertEqual(len(commands), 1)
        command = commands[0] + '\nprintf "%s\\n" "$VERSION"'
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'desktop').mkdir()
            package = root / 'desktop/package.json'
            package.write_text('{"version": "0.2.29"}')
            result = subprocess.run(
                ['bash', '-e', '-o', 'pipefail', '-c', command],
                cwd=root, capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), '0.2.29')

            package.unlink()
            (root / 'payload.cjs').write_text(
                "require('node:fs').writeFileSync('executed', 'yes');\n"
                "module.exports = {version: '0.2.29'};\n"
            )
            package.symlink_to('../payload.cjs')
            result = subprocess.run(
                ['bash', '-e', '-o', 'pipefail', '-c', command],
                cwd=root, capture_output=True, text=True, check=False,
            )
            self.assertFalse((root / 'executed').exists(), 'version extraction executed JavaScript')
            self.assertNotEqual(result.returncode, 0)

    def test_rejects_release_capabilities_and_missing_checks(self):
        mutations = {
            'smoke concurrency collision': lambda w: w['concurrency'].update(group='desktop-build-${{ github.ref }}'),
            'environment': lambda w: w['jobs']['release-build'].update(environment='release'),
            'oidc': lambda w: w['jobs']['release-build']['permissions'].update({'id-token': 'write'}),
            'write token': lambda w: w['permissions'].update(contents='write'),
            'secret': lambda w: w['jobs']['release-build'].update(env={'KEY': '${{ secrets.SIGNING_KEY }}'}),
            'publication': lambda w: w['jobs']['release-build']['steps'].append({'run': 'gh release create tag'}),
            'extra publisher': lambda w: w['jobs'].update(publish={'runs-on': 'ubuntu-latest', 'steps': [{'run': 'true'}]}),
            'privileged event': lambda w: w['on'].update(pull_request_target={}),
            'weak guard': lambda w: w['jobs']['release-build'].update({'if': 'true'}),
            'missing leg': lambda w: w['jobs']['release-build']['strategy']['matrix']['include'].pop(),
            'missing checks': lambda w: w['jobs']['release-build'].update(steps=[]),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                shutil.copytree(ROOT / '.github/workflows', root / '.github/workflows')
                path = root / '.github/workflows/build-desktop.yml'
                workflow = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
                mutate(workflow)
                path.write_text(yaml.safe_dump(workflow))
                with self.assertRaises(ValueError):
                    unsigned.verify(root)

    def test_missing_workflow_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(OSError):
            unsigned.verify(pathlib.Path(directory))

    def test_rejects_smoke_ioc_bypasses(self):
        mutations = {
            'missing gate': lambda jobs: jobs.pop('ioc'),
            'missing dependency': lambda jobs: jobs['pr-smoke-build'].update(needs=['pr-paths-filter']),
            'failed gate bypass': lambda jobs: jobs['pr-smoke-build'].update({'if': 'always()'}),
            'ignored scan failure': lambda jobs: jobs['ioc'].update({'continue-on-error': 'true'}),
            'conditional scan': lambda jobs: jobs['ioc'].update({'if': 'false'}),
            'untrusted scanner': lambda jobs: jobs['ioc'].update(uses='other/repo/.github/workflows/ioc.yml@main'),
            'aggregate bypass': lambda jobs: jobs['pr-smoke-result'].update(needs=['pr-paths-filter', 'pr-smoke-build']),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                shutil.copytree(ROOT / '.github/workflows', root / '.github/workflows')
                path = root / '.github/workflows/desktop-pr-smoke.yml'
                workflow = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
                mutate(workflow['jobs'])
                path.write_text(yaml.safe_dump(workflow))
                with self.assertRaises(ValueError):
                    unsigned.verify(root)

    def test_rejects_release_tag_build_capabilities(self):
        build = lambda w: w['jobs']['release-build']
        mutations = {
            'branch trigger': lambda w: w['on'].update(push={'branches': ['main']}),
            'dispatch trigger': lambda w: w['on'].update(workflow_dispatch={}),
            'write token': lambda w: w['permissions'].update(contents='write'),
            'release write': lambda w: build(w)['permissions'].update(contents='write'),
            'environment': lambda w: build(w).update(environment='apple'),
            'secret': lambda w: build(w).update(env={'KEY': '${{ secrets.SIGNING_KEY }}'}),
            'inherited secrets': lambda w: w['jobs']['ioc'].update(secrets='inherit'),
            'secrets as JSON': lambda w: build(w).update(env={'ALL': '${{ toJSON(secrets) }}'}),
            'publication': lambda w: build(w)['steps'].append({'run': 'gh release create v1.0.0'}),
            'extra job': lambda w: w['jobs'].update(publish={'runs-on': 'ubuntu-latest', 'steps': [{'run': 'true'}]}),
            'tag check skipped': lambda w: build(w).update(needs=['ioc']),
            'self-hosted leg': lambda w: build(w)['strategy']['matrix']['include'][0].update(os='blacksmith-4vcpu-windows-2025'),
            'step drift': lambda w: build(w)['steps'].pop(3),
            'unattested upload': lambda w: build(w).update(steps=[
                s for s in build(w)['steps'] if s.get('name') != 'Attest build provenance (Linux)']),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                shutil.copytree(ROOT / '.github/workflows', root / '.github/workflows')
                path = root / '.github/workflows/release.yml'
                workflow = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
                mutate(workflow)
                path.write_text(yaml.safe_dump(workflow))
                with self.assertRaises(ValueError):
                    unsigned.verify(root)

    def test_smoke_aggregate_fails_closed_on_ioc_and_preserves_path_filter(self):
        workflow = yaml.load((ROOT / '.github/workflows/desktop-pr-smoke.yml').read_text(), Loader=yaml.BaseLoader)
        job = workflow['jobs']['pr-smoke-result']
        self.assertEqual(job['if'], "${{ github.event_name == 'pull_request' && always() }}")
        step = next(step for step in job['steps'] if step.get('name') == 'Aggregate result')
        self.assertEqual(step['env']['IOC_RESULT'], '${{ needs.ioc.result }}')
        cases = [
            ('success', 'success', 'true', 'success', True),
            ('success', 'success', 'false', 'skipped', True),
            ('success', 'failure', '', 'skipped', False),
            ('success', 'success', 'true', 'skipped', False),
            ('success', 'success', 'true', 'failure', False),
        ]
        for ioc in ['failure', 'cancelled', 'skipped', '']:
            for paths in ['true', 'false']:
                cases.append((ioc, 'success', paths, 'skipped', False))
        for ioc, filtered, paths, built, success in cases:
            with self.subTest(ioc=ioc, filtered=filtered, paths=paths, built=built):
                result = subprocess.run(
                    ['bash', '-e', '-o', 'pipefail', '-c', step['run']],
                    env={**os.environ, 'IOC_RESULT': ioc, 'PATHS_FILTER_RESULT': filtered,
                         'DESKTOP_SHELL': paths, 'SMOKE_BUILD_RESULT': built},
                    capture_output=True, text=True, check=False,
                )
                self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
