#!/usr/bin/env python3
"""Export committed changes as ordinary Git patches without touching the checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def git(repo, *args, env=None):
    return subprocess.check_output(['git', '-C', str(repo), *args], env=env)


def export(repo, base, head, output, verify=False):
    base = git(repo, 'rev-parse', '--verify', base + '^{commit}').decode().strip()
    head = git(repo, 'rev-parse', '--verify', head + '^{commit}').decode().strip()
    git(repo, 'merge-base', '--is-ancestor', base, head)
    # Merge commits cannot be represented faithfully by a linear format-patch series.
    if git(repo, 'rev-list', '--merges', base + '..' + head).strip():
        raise ValueError('Range contains merges; use a linear integration branch for patch export')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    commits = git(repo, 'rev-list', '--reverse', base + '..' + head).decode().splitlines()
    records = []
    for number, commit in enumerate(commits, 1):
        patch = git(repo, 'format-patch', '--stdout', '--binary', '--full-index', '--no-signature', '-1', commit)
        name = f'{number:04d}-{commit[:12]}.patch'
        (output / name).write_bytes(patch)
        records.append({'commit': commit, 'file': name, 'sha256': hashlib.sha256(patch).hexdigest(),
                        'subject': git(repo, 'show', '-s', '--format=%s', commit).decode().strip()})
    diff = git(repo, 'diff', '--binary', '--full-index', base, head)
    (output / 'complete.patch').write_bytes(diff)
    if verify:
        # A private index replays every patch; the real index/worktree and refs are untouched.
        with tempfile.TemporaryDirectory(prefix='9router-patch-index-') as tmp:
            env = {**os.environ, 'GIT_INDEX_FILE': str(Path(tmp) / 'index')}
            git(repo, 'read-tree', base, env=env)
            for record in records:
                git(repo, 'apply', '--cached', '--whitespace=nowarn', str((output / record['file']).resolve()), env=env)
            actual = git(repo, 'write-tree', env=env).decode().strip()
        expected = git(repo, 'rev-parse', head + '^{tree}').decode().strip()
        if actual != expected:
            raise ValueError('Replayed tree differs from source; do not publish this patch set')
    manifest = {'base': base, 'head': head, 'verified': verify, 'patches': records,
                'complete_patch_sha256': hashlib.sha256(diff).hexdigest()}
    (output / 'series.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--head', default='HEAD')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    config = json.loads((repo / 'patches/upstream.json').read_text())
    result = export(repo, config['base'], args.head, args.output, args.verify)
    print(f"Exported {len(result['patches'])} commits; replay verified: {result['verified']}")
