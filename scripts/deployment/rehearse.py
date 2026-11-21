#!/usr/bin/env python3
"""Exercise the receiver on a disposable Linux Docker runner with synthetic data."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from unittest.mock import patch

import receive


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def rehearse(tag, base):
    existing = docker('ps', '-a', '--format', '{{.Names}}').splitlines()
    check(not any(name == receive.NAME or name.startswith(('9router-before-', '9router-ci-check-'))
                  for name in existing), 'Use a disposable runner without 9Router containers')
    revisions = [hashlib.sha1(f'{tag}:rehearsal:{i}'.encode()).hexdigest() for i in range(8)]
    tags = ['9router-ci:' + sha for sha in revisions]
    names = {receive.NAME, *('9router-before-' + sha[:12] for sha in revisions),
             *('9router-ci-check-' + sha[:12] for sha in revisions)}
    network = docker('network', 'create', '--internal', receive.NETWORK)
    try:
        images = []
        for sha, variant in zip(revisions, tags):
            builder = docker('create', tag)
            try:
                images.append(docker('commit', '--change', f'LABEL {receive.REVISION_LABEL}={sha}',
                                     builder, variant))
            finally:
                docker('rm', builder)
        with tempfile.TemporaryDirectory(prefix='9router-ci-rehearse-') as directory:
            root = Path(directory)
            data, state = root / 'data', root / 'ci'
            data.mkdir()
            state.mkdir()
            docker('run', '-d', '--name', receive.NAME, '--network', receive.NETWORK,
                   '--restart', 'unless-stopped', '-v', f'{data}:/app/data',
                   '-e', 'IMAGE_ADMIN_TEST_WORKER_ENABLED=false',
                   '-e', 'DISABLE_BACKGROUND_TOKEN_REFRESH=true', tags[5])
            receive.healthy(receive.NAME)
            with closing(sqlite3.connect(data / receive.DB)) as db, db:
                db.execute('create table ci_rehearsal (id integer primary key, value text)')
                db.execute("insert into ci_rehearsal values (1, 'preserved')")
            with patch.object(receive, 'DATA', data), patch.object(receive, 'STATE', state):
                for i, sha in enumerate(revisions[:6]):
                    previous = '9router-before-' + sha[:12]
                    release = state / (sha + '-' + str(i + 1))
                    release.mkdir()
                    receive.receipt(release / 'result.json', {'commit': sha, 'image': images[i],
                                    'previous': previous, 'status': 'deployed'})
                    if i:
                        docker('create', '--name', previous, '--network', 'none', '--entrypoint',
                               '/bin/true', tags[i - 1])
                        docker('start', previous)
                        check(docker('wait', previous) == '0', 'Legacy rollback fixture failed')
                    if i == 1:
                        receive.copy_data(data, release / 'backup')

                keep, retire, unknown = receive.rollback_plan()
                check(len(keep) == 5 and not retire and not unknown, 'Legacy rollback detection failed')
                for i in (6, 7):
                    sha = revisions[i]
                    with patch.object(receive, 'current_head', return_value=sha):
                        receive.deploy_loaded(sha, base)
                    receive.retention()
                    keep, retire, unknown = receive.rollback_plan()
                    check(len(keep) == 5 and not retire and not unknown, 'Rollback limit failed')
                    check(docker('container', 'inspect', '--format', '{{.Image}}', receive.NAME) == images[i],
                          'Wrong serving image after cutover')
                    check(not (state / 'pending.json').exists(), 'Unexpected pending recovery')
                    with closing(sqlite3.connect(data / receive.DB)) as db:
                        check(db.execute('select value from ci_rehearsal').fetchone() == ('preserved',),
                              'Cutover changed the database fixture')
                    result = next(state.glob(sha + '-*/backup')) / receive.DB
                    with closing(sqlite3.connect(f'file:{result}?mode=ro', uri=True)) as db:
                        check(db.execute('pragma integrity_check').fetchone() == ('ok',)
                              and db.execute('select value from ci_rehearsal').fetchone() == ('preserved',),
                              'Recovery snapshot failed validation')
                    check(not any(row.startswith(tags[i - 6] + ' ') for row in
                                  docker('images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}').splitlines()),
                          'Retired image tag survived cleanup')
                archive_mount = root / 'archive'
                archive_mount.mkdir()
                subprocess.run(['mount', '-t', 'tmpfs', '-o', 'size=128m', 'tmpfs', str(archive_mount)], check=True)
                try:
                    receive.archive_retired(archive_mount)
                    release = state / (revisions[1] + '-2')
                    result = json.loads((release / 'result.json').read_text())
                    archive = archive_mount / '9router-ci' / result['backupArchive']
                    check(not (release / 'backup').exists()
                          and hashlib.sha256(archive.read_bytes()).hexdigest() == result['backupSha256'],
                          'Archive receipt or source removal failed')
                    restored = root / 'restored'
                    restored.mkdir()
                    subprocess.run(['tar', '-xzf', str(archive), '-C', str(restored)], check=True)
                    with closing(sqlite3.connect(restored / 'backup' / receive.DB)) as db:
                        check(db.execute('pragma integrity_check').fetchone() == ('ok',)
                              and db.execute('select value from ci_rehearsal').fetchone() == ('preserved',),
                              'Archive restore failed')
                finally:
                    subprocess.run(['umount', str(archive_mount)], check=True)
    finally:
        for name in names:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL)
        for variant in tags:
            subprocess.run(['docker', 'image', 'rm', variant], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    rehearse(sys.argv[1], receive.validate_revision(sys.argv[2]))
