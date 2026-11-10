#!/usr/bin/env python3
"""Exercise the PR guard workflow steps with isolated Git repositories."""
import os
from pathlib import Path
import subprocess
import tempfile
import yaml

workflow = yaml.load(Path(__file__).resolve().parents[3].joinpath('.github/workflows/refresh-ioc-list.yml').read_text(), Loader=yaml.BaseLoader)
steps = {step.get('id'): step for step in workflow['jobs']['guard']['steps'] if step.get('id')}
changed = steps['changed']['run']
validation = steps['validation']['run']
assert 'GH_TOKEN' not in steps['validation'].get('env', {})
assert 'GITHUB_TOKEN' not in steps['validation'].get('env', {})
comment = next(step for step in workflow['jobs']['guard']['steps'] if step.get('name') == 'Update IOC refresh guard comment')
assert comment['env']['GH_TOKEN'] == '${{ github.token }}'
assert 'ioc-refresh-guard.md' not in comment['run']
assert 'pull_request' in workflow['on'] and 'pull_request_target' not in workflow['on']

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory) / "repo"
    root.mkdir()
    ioc = root / 'scripts/security/iocs/shai-hulud-2.0.txt'
    ioc.parent.mkdir(parents=True)
    ioc.write_text('old\n')
    guard = root / 'scripts/security/check-ioc-refresh-pr.sh'
    guard.write_text('test -z "${GH_TOKEN+x}${GITHUB_TOKEN+x}" || exit 1\ntouch invoked\necho "Guard reason: PASS"\n')
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=root, text=True).strip()
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test Harness')
    git('config', 'user.email', 'test@example.com')
    git('add', '.')
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base')
    base = git('rev-parse', 'HEAD')
    output = Path(directory) / 'output'
    summary = Path(directory) / 'summary'
    def run(script, head):
        output.write_text('')
        summary.write_text('')
        env = dict(os.environ, BASE_SHA=base, HEAD_SHA=head, GITHUB_OUTPUT=str(output),
                   GITHUB_STEP_SUMMARY=str(summary), GH_TOKEN='inert-token', GITHUB_TOKEN='inert-token')
        subprocess.run(['bash', '-e', '-c', script], cwd=root, env=env, check=True)
        return output.read_text()
    def commit(message):
        git('add', '.')
        git('-c', 'commit.gpgsign=false', 'commit', '-qm', message)
        return git('rev-parse', 'HEAD')
    ioc.unlink()
    ioc.symlink_to('/proc/self/environ')
    head = commit('symlink')
    assert run(changed, head) == 'changed=true\n'
    assert run(validation, head) == 'result=fail\nreason=INVALID_FILE\n'
    assert not (root / 'invoked').exists()
    ioc.unlink()
    ioc.write_text('legitimate\n')
    head = commit('regular')
    assert run(changed, head) == 'changed=true\n'
    assert run(validation, head) == 'result=pass\nreason=PASS\n'
    assert (root / 'invoked').exists()
    assert run(validation, git('rev-parse', base)) == 'result=fail\nreason=INVALID_FILE\n'

# Fork tokens may be read-only; same-repository tokens may post the fixed comment.
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    gh = root / 'gh'
    gh.write_text('''#!/usr/bin/env bash
if [[ " $* " == *" --paginate "* ]]; then exit 0; fi
printf '%s\\n' "$*" >> "$GH_CALLS"
[[ "$CAN_WRITE" == true ]]
''')
    gh.chmod(0o755)
    for can_write in ('true', 'false'):
        calls = root / 'calls'
        calls.write_text('')
        env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}", GH_CALLS=str(calls),
                   CAN_WRITE=can_write, GUARD_RESULT='fail', GUARD_REASON='COLLISION', GH_TOKEN='inert-secret',
                   GITHUB_REPOSITORY='owner/repo', PR_NUMBER='1')
        result = subprocess.run(['bash', '-e', '-c', comment['run']], env=env, capture_output=True, text=True)
        assert result.returncode != 0
        body = calls.read_text()
        assert '@Concord-Voice/security IOC refresh guard failed' in body
        assert 'Guard reason: COLLISION' in body
        assert 'inert-secret' not in body
        assert 'ioc-refresh-guard.md' not in body
        calls.write_text('')
        env['GUARD_REASON'] = 'COLLISION\ninert-secret'
        result = subprocess.run(['bash', '-e', '-c', comment['run']], env=env, capture_output=True, text=True)
        assert result.returncode != 0
        assert 'Guard reason: INTERNAL' in calls.read_text() and 'inert-secret' not in calls.read_text()
        calls.write_text('')
        env['GUARD_RESULT'] = 'pass'
        result = subprocess.run(['bash', '-e', '-c', comment['run']], env=env, capture_output=True, text=True)
        assert result.returncode == 0 and not calls.read_text()
