#!/usr/bin/env python3
"""Desktop D1: unsigned artifacts cannot acquire release capabilities."""
import pathlib
import re
import sys
import yaml


def verify(root):
    workflows = root / '.github/workflows'
    build = yaml.load((workflows / 'build-desktop.yml').read_text(), Loader=yaml.BaseLoader)
    smoke = yaml.load((workflows / 'desktop-pr-smoke.yml').read_text(), Loader=yaml.BaseLoader)
    if set(build['jobs']) != {'ioc', 'detect-release', 'release-build'}:
        raise ValueError('unsigned workflow must contain only IOC, detection and packaging jobs')
    if set(build['on']) != {'pull_request', 'workflow_dispatch'}:
        raise ValueError('unsigned workflow must use ordinary PR or dispatch events')
    for name, workflow in [('build-desktop', build), ('desktop-pr-smoke', smoke)]:
        if workflow.get('permissions') != {'contents': 'read'}:
            # PR smoke also needs read-only PR metadata for its existing path filter.
            if name != 'desktop-pr-smoke' or workflow.get('permissions') != {'contents': 'read', 'pull-requests': 'read'}:
                raise ValueError(f'{name}: workflow permissions must be read-only')
        text = yaml.safe_dump(workflow)
        if re.search(r'\bsecrets\s*(?:\.|\[)|gh\s+release|git\s+push|azure/login|attest-build-provenance|apple-actions/import-codesign-certs', text):
            raise ValueError(f'{name}: signing, secrets or publication is forbidden')
        for job in workflow['jobs'].values():
            if 'environment' in job or any(v != 'read' for v in job.get('permissions', {}).values()):
                raise ValueError(f'{name}: jobs cannot acquire release privileges')
            for step in job.get('steps', []):
                if name == 'desktop-pr-smoke' and 'actions/upload-artifact@' in step.get('uses', ''):
                    raise ValueError('PR smoke must not upload promotable artifacts')
    job = build['jobs']['release-build']
    guard = ' '.join(job['if'].split())
    required = ["github.repository == 'Concord-Voice/Desktop'", "github.event_name == 'pull_request'",
                "github.ref == 'refs/heads/main'", "github.event_name == 'workflow_dispatch'",
                "needs.detect-release.result == 'success'", "needs.detect-release.outputs.should_release == 'true'"]
    expected = (required[0] + ' && (' + required[1] + ' || (' + required[2] + ' && ' + required[3] + ')) && ' + "needs.ioc.result == 'success' && " + required[4] + ' && ' + required[5])
    if guard != expected:
        raise ValueError('unsigned packaging must use the exact repository/event/detection guard')
    if job.get('needs') != ['detect-release', 'ioc'] or build['jobs']['ioc'].get('uses') != './.github/workflows/ioc-scanning.yml':
        raise ValueError('packaging dependencies must follow the IOC gate')
    steps = job['steps']
    checkouts = [s for s in steps if s.get('uses', '').startswith('actions/checkout@')]
    if len(checkouts) != 1 or checkouts[0].get('with', {}).get('ref') != '${{ github.sha }}':
        raise ValueError('packaging checkout must bind to the event commit')
    required_steps = ['Verify exact trusted HEAD', 'Verify asar integrity and preload bundle',
                      'Verify packaged Electron fuses', 'Verify Linux package desktop integration',
                      'Upload artifacts (Windows)', 'Upload artifacts (macOS)', 'Upload artifacts (Linux)']
    for name in required_steps:
        matches = [s for s in steps if s.get('name') == name]
        if len(matches) != 1 or 'continue-on-error' in matches[0]:
            raise ValueError(f'missing or non-enforcing artifact check: {name}')
    if len(job['strategy']['matrix']['include']) != 6:
        raise ValueError('all six platform/architecture packaging legs are required')


def main():
    if len(sys.argv) > 2:
        print('ERROR: expected zero or one repository-root argument', file=sys.stderr)
        return 2
    try:
        verify(pathlib.Path(sys.argv[1] if len(sys.argv) == 2 else '.'))
    except (OSError, KeyError, TypeError, yaml.YAMLError) as error:
        print(f'ERROR: invalid workflow input: {error}', file=sys.stderr)
        return 2
    except ValueError as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1
    print('OK: unsigned Desktop artifacts have no signing or publication capability')
    return 0


if __name__ == '__main__':
    sys.exit(main())
