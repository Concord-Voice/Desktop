#!/usr/bin/env python3
"""Desktop D1: unsigned artifacts cannot acquire release capabilities."""
import hashlib
import json
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
        if re.search(r'\bsecrets\b|gh\s+release|git\s+push|azure/login|attest-build-provenance|apple-actions/import-codesign-certs', text):
            raise ValueError(f'{name}: signing, secrets or publication is forbidden')
        for job in workflow['jobs'].values():
            if 'environment' in job or any(v != 'read' for v in job.get('permissions', {}).values()):
                raise ValueError(f'{name}: jobs cannot acquire release privileges')
            for step in job.get('steps', []):
                if name == 'desktop-pr-smoke' and 'actions/upload-artifact@' in step.get('uses', ''):
                    raise ValueError('PR smoke must not upload promotable artifacts')
    if build.get('concurrency', {}).get('group') == smoke.get('concurrency', {}).get('group'):
        raise ValueError('unsigned artifacts must not share the smoke lane cancellation group')
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
    smoke_jobs = smoke['jobs']
    expected_ioc = {'uses': './.github/workflows/ioc-scanning.yml',
                    'permissions': {'contents': 'read', 'pull-requests': 'read'}}
    smoke_guard = ("github.event_name == 'pull_request' && needs.ioc.result == 'success' && "
                   "needs.pr-paths-filter.outputs.desktop-shell == 'true'")
    if (smoke_jobs.get('ioc') != expected_ioc
            or smoke_jobs['pr-smoke-build'].get('needs') != ['pr-paths-filter', 'ioc']
            or ' '.join(smoke_jobs['pr-smoke-build']['if'].split()) != smoke_guard):
        raise ValueError('PR smoke installation must follow the enforcing IOC gate')
    if smoke_jobs['pr-smoke-result'].get('needs') != ['pr-paths-filter', 'pr-smoke-build', 'ioc']:
        raise ValueError('PR smoke result must wait for the IOC verdict')
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
    verify_release(workflows, job)
    verify_pull_request_target(workflows)


SAME_REPO = 'github.event.pull_request.head.repo.full_name == github.repository'


def verify_pull_request_target(workflows):
    """A pull_request_target job holds a write-capable token, so it may read the PR only as Git
    objects. github.sha is the protected base tip only while main is the sole target branch."""
    for path in sorted(workflows.glob('*.y*ml')):
        doc = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
        on = doc.get('on')
        if not isinstance(on, dict) or 'pull_request_target' not in on:
            continue
        for name, job in doc.get('jobs', {}).items():
            checkouts = [s for s in job.get('steps', []) if 'actions/checkout@' in s.get('uses', '')]
            if not checkouts:
                continue
            where = f'{path.name}:{name}'
            trigger = on['pull_request_target']
            if set(on) != {'pull_request_target'} or not isinstance(trigger, dict) or trigger.get('branches') != ['main']:
                raise ValueError(f'{where}: a checkout under pull_request_target needs main as the only trigger branch')
            if SAME_REPO not in ' '.join(job.get('if', '').split()):
                raise ValueError(f'{where}: a checkout under pull_request_target must be same-repository only')
            perms = job.get('permissions')
            if not isinstance(perms, dict) or perms.get('contents', 'none') not in ('read', 'none'):
                raise ValueError(f'{where}: a checkout job must not hold contents: write')
            for step in checkouts:
                w = step.get('with', {})
                if (w.get('ref') != '${{ github.sha }}' or w.get('persist-credentials') != 'false'
                        or 'repository' in w):
                    raise ValueError(f'{where}: checkout must be the protected github.sha with persist-credentials: false')
            if any(re.search(r'\bgit\s+(checkout|switch|worktree|restore)\b', s.get('run', '')) for s in job['steps']):
                raise ValueError(f'{where}: must not materialize PR-head files')


RELEASE_PERMISSIONS = {'contents': 'read', 'id-token': 'write', 'attestations': 'write'}


def verify_release(workflows, unsigned_job):
    """D2 tag build: attests provenance, holds no credential, writes no release."""
    release = yaml.load((workflows / 'release.yml').read_text(), Loader=yaml.BaseLoader)
    if release.get('on') != {'push': {'tags': ['v*']}}:
        raise ValueError('release: must run only on a v* tag push')
    if release.get('permissions') != {'contents': 'read'}:
        raise ValueError('release: workflow permissions must be read-only')
    if set(release['jobs']) != {'ioc', 'check-tag', 'release-build', 'leg-digests', 'sbom', 'attach-sbom'}:
        raise ValueError('release: must contain only IOC, tag check, packaging and SBOM jobs')
    text = yaml.safe_dump(release)
    if re.search(r'\bsecrets\b|gh\s+release|git\s+push|azure/login|apple-actions/import-codesign-certs', text):
        raise ValueError('release: signing, secrets or publication is forbidden')
    for name, job in release['jobs'].items():
        if 'environment' in job:
            raise ValueError(f'release: {name} cannot use an environment')
        perms = job.get('permissions', {})
        if name in ('release-build', 'attach-sbom'):
            if perms != RELEASE_PERMISSIONS:
                raise ValueError('release: packaging may only add attestation permissions')
        elif any(v != 'read' for v in perms.values()):
            raise ValueError(f'release: {name} must be read-only')
    job = release['jobs']['release-build']
    if job.get('needs') != ['check-tag', 'ioc']:
        raise ValueError('release: packaging must follow the IOC gate and tag check')
    if job.get('runs-on') != '${{ matrix.os }}':
        raise ValueError('release: packaging must run on the matrix runner')
    if any('blacksmith' in leg['os'] or 'self-hosted' in leg['os'] for leg in job['strategy']['matrix']['include']):
        raise ValueError('release: legs must run on GitHub-hosted runners (Release-Ops refuses others)')
    build_steps = [s.get('name') for s in job['steps'] if 'attest-build-provenance@' not in s.get('uses', '')]
    if build_steps != [s.get('name') for s in unsigned_job['steps']]:
        raise ValueError('release: packaging steps drifted from build-desktop.yml release-build')
    attests = [s for s in job['steps'] if 'attest-build-provenance@' in s.get('uses', '')]
    uploads = [s for s in job['steps'] if 'actions/upload-artifact@' in s.get('uses', '')]
    attested = sorted(p for s in attests for p in s['with']['subject-path'].split())
    uploaded = sorted(p for s in uploads for p in s['with']['path'].split())
    if not attests or attested != uploaded:
        raise ValueError('release: attested paths must equal uploaded paths')
    verify_release_sbom(release, job)


def job_digest(job):
    return hashlib.sha256(json.dumps(job, sort_keys=True).encode()).hexdigest()


# #218: the two jobs that see release bytes next to id-token are pinned exactly,
# so no step, shell, container or path can change without a reviewed update
# here. After reviewing a change to either job, set its new digest (printed by
# the error) below.
PINNED_JOBS = {
    'leg-digests': '0e8ad7028daeb2ef05b30e8f4a9a91e3e8b718fb62da7ee0524dc87e4a12a6fa',
    'attach-sbom': '19faef6f7f1116003ef9e8f4837bff57f9957665622438514ecf1ac0e2d84c08',
}


def verify_release_sbom(release, build):
    """#218: the scanner runs without id-token; the jobs around it are pinned."""
    jobs = release['jobs']
    if 'defaults' in release or any('defaults' in job for job in jobs.values()):
        raise ValueError('release: defaults would change every run step')
    if (jobs['leg-digests'].get('needs') != ['check-tag', 'release-build']
            or jobs['sbom'].get('needs') != ['check-tag', 'leg-digests']
            or jobs['attach-sbom'].get('needs') != ['check-tag', 'leg-digests', 'sbom']):
        raise ValueError('release: digests, scanner and attach must run in that order after packaging')
    if jobs['sbom'].get('permissions') != {'contents': 'read'}:
        raise ValueError('release: the SBOM scanner job must be read-only')
    labels = [leg['label'] for leg in build['strategy']['matrix']['include']]
    if jobs['attach-sbom']['strategy']['matrix'].get('label') != labels:
        raise ValueError('release: every packaging leg needs its SBOM attached')
    for name, pin in PINNED_JOBS.items():
        digest = job_digest(jobs[name])
        if digest != pin:
            raise ValueError(f'release: {name} changed (sha256 {digest}); review it, then update PINNED_JOBS')

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
