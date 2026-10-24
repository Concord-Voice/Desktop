#!/usr/bin/env python3
"""Exercise the actual unsigned lane and fail-closed privilege boundaries."""
import importlib.util
import pathlib
import shutil
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

    def test_rejects_release_capabilities_and_missing_checks(self):
        mutations = {
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


if __name__ == '__main__':
    unittest.main()
