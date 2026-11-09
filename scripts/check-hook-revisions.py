#!/usr/bin/env python3
"""Require immutable remote pre-commit revisions with their frozen tag comment."""
from pathlib import Path
import re
import sys

import yaml

PIN = re.compile(r'[0-9a-f]{40}\Z')
PIN_LINE = re.compile(r'[ \t]*rev:[ \t]+([0-9a-f]{40})[ \t]+# frozen: \S+[ \t]*\Z')


def check(path):
    source = Path(path).read_text()
    doc = yaml.safe_load(source)
    if not isinstance(doc, dict) or not isinstance(doc.get('repos'), list):
        raise ValueError('pre-commit repos must be a list')
    node = yaml.compose(source)
    repos_nodes = [value for key, value in node.value if key.value == 'repos']
    if len(repos_nodes) != 1 or not isinstance(repos_nodes[0], yaml.SequenceNode):
        raise ValueError('pre-commit repos must occur exactly once as a list')
    lines = source.splitlines()
    failures = []
    for n, (repo, repo_node) in enumerate(zip(doc['repos'], repos_nodes[0].value), 1):
        if not isinstance(repo, dict) or not isinstance(repo.get('repo'), str):
            failures.append(f'repos[{n}] is invalid')
            continue
        if repo['repo'] in ('local', 'meta'):
            continue
        rev_keys = [key for key, _ in repo_node.value if key.value == 'rev']
        if len(rev_keys) != 1:
            failures.append(f'repos[{n}] must have exactly one rev')
            continue
        rev = repo.get('rev')
        if not isinstance(rev, str) or not PIN.fullmatch(rev):
            failures.append(f'repos[{n}] has movable or missing rev {rev!r}')
            continue
        # Parse the value first: line-only matching misses `rev : main` and
        # inline mappings. The canonical line binds the frozen tag to this rev
        # and rejects aliases, duplicate keys and comment decoys.
        match = PIN_LINE.fullmatch(lines[rev_keys[0].start_mark.line])
        if not match or match[1] != rev:
            failures.append(f'repos[{n}] must use `rev: <SHA>  # frozen: <tag>`')
    return failures


if __name__ == '__main__':
    try:
        failures = check(sys.argv[1])
    except (OSError, yaml.YAMLError, ValueError) as error:
        print(f'pin guard: {error}', file=sys.stderr)
        sys.exit(1)
    for failure in failures:
        print(f'pin guard: {failure}', file=sys.stderr)
    sys.exit(bool(failures))
