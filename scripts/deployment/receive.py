#!/usr/bin/env python3
"""Receive one CI-built image through a restricted SSH key; preserve live data."""
import copy
from contextlib import closing
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path('/opt/9router-render')
STATE = ROOT / 'ci'
DATA = ROOT / 'data'
DB = Path('db/data.sqlite')
REPOSITORY = 'minthanthtoo/9router'
BRANCH = 'master'
NAME = '9router'
NETWORK = '9router-net'


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(120)
        self.sock.connect('/var/run/docker.sock')


def docker(method, path, body=None):
    conn = DockerConnection('localhost', timeout=120)
    conn.request(method, '/v1.41' + path, json.dumps(body) if body is not None else None,
                 {'Content-Type': 'application/json'})
    response = conn.getresponse()
    raw = response.read()
    conn.close()
    if response.status >= 400:
        # Docker errors may contain runtime configuration; retain no response body.
        raise RuntimeError(f'Docker operation failed: {method} {path} ({response.status})')
    return json.loads(raw) if raw else None


def validate_revision(value):
    if not re.fullmatch('[0-9a-f]{40}', value):
        raise ValueError('Expected an immutable Git commit SHA')
    return value


def current_head():
    request = urllib.request.Request(f'https://api.github.com/repos/{REPOSITORY}/git/ref/heads/{BRANCH}',
                                     headers={'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)['object']['sha']


def receipt(path, data):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        stream.write(json.dumps(data, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def copy_data(source, destination):
    if any(p.is_symlink() for p in source.rglob('*')):
        raise RuntimeError('Data contains symlinks; deployment requires review')
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns('data.sqlite', 'data.sqlite-wal', 'data.sqlite-shm'))
    with closing(sqlite3.connect(f'file:{source / DB}?mode=ro', uri=True)) as src, closing(sqlite3.connect(destination / DB)) as dst:
        src.backup(dst)


def snapshot(path):
    result = {}
    with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as db:
        if db.execute('pragma integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Database integrity check failed')
        for (name,) in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name != '_meta'"):
            quoted = '"' + name.replace('"', '""') + '"'
            info = list(db.execute('pragma table_info(' + quoted + ')'))
            columns = [r[1] for r in info]
            keys = [columns.index(r[1]) for r in sorted(info, key=lambda r: r[5]) if r[5]]
            rows = db.execute('select ' + ('' if keys else 'rowid,') + '* from ' + quoted).fetchall()
            keyed = [(tuple(r[i] for i in keys), r) if keys else ((r[0],), r[1:]) for r in rows]
            # Keep row identity in every column hash; credentials must never swap accounts.
            result[name] = {column: hashlib.sha256(json.dumps(sorted(repr((key, r[i])) for key, r in keyed)).encode()).hexdigest()
                            for i, column in enumerate(columns)}
    return result


def file_snapshot(root):
    ignored = {'data.sqlite', 'data.sqlite-wal', 'data.sqlite-shm', 'data.sqlite-journal'}
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file() and p.name not in ignored
            and p.relative_to(root).parts[:2] != ('db', 'backups')}


def preserved(before, after):
    if any(after.get(table, {}).get(column) != digest for table, columns in before.items()
           for column, digest in columns.items()):
        raise RuntimeError('Migration changed existing database values; release rejected')


def assert_idle(path):
    with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as db:
        tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
        if 'imageQuotaRequestSubmissions' in tables and db.execute("select count(*) from imageQuotaRequestSubmissions where outcome='in_flight'").fetchone()[0]:
            raise RuntimeError('Image requests are in flight; retry deployment when idle')
        if 'adminImageTestRuns' in tables and db.execute("select count(*) from adminImageTestRuns where state in ('queued','running','stopping')").fetchone()[0]:
            raise RuntimeError('Image tests are active; retry deployment when idle')


def configuration(old, image, data, rehearsal=False):
    config = copy.deepcopy(old['Config'])
    config['Image'] = image
    host = copy.deepcopy(old['HostConfig'])
    host.update(NetworkMode='none', RestartPolicy={'Name': 'no', 'MaximumRetryCount': 0})
    host.pop('PortBindings', None)
    if rehearsal:
        host.pop('Mounts', None)
        host['Binds'] = [f'{data}:/app/data']
        overrides = {'IMAGE_ADMIN_TEST_WORKER_ENABLED': 'false', 'DISABLE_BACKGROUND_TOKEN_REFRESH': 'true'}
        config['Env'] = [x for x in config.get('Env', []) if x.split('=', 1)[0] not in overrides]
        config['Env'] += [f'{k}={v}' for k, v in overrides.items()]
    config['HostConfig'] = host
    config['NetworkingConfig'] = {'EndpointsConfig': {}}
    return config


def healthy(name):
    script = "Promise.all(['/api/health','/api/private/image-quota/v1'].map(async p=>{let r=await fetch('http://127.0.0.1:20128'+p);return [r.status,p.endsWith('health')?(await r.json()).ok:null]})).then(x=>process.exit(x[0][0]===200&&x[0][1]===true&&x[1][0]===401?0:1)).catch(()=>process.exit(1))"
    for _ in range(45):
        if subprocess.run(['docker', 'exec', name, 'node', '-e', script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError('Candidate health/auth check failed')


def create_start(name, config):
    docker('POST', '/containers/create?name=' + name, config)
    docker('POST', '/containers/' + name + '/start')


def deploy(sha):
    if (STATE / 'pending.json').exists():
        raise RuntimeError('Previous cutover requires review; current data preserved')
    if current_head() != sha:
        raise RuntimeError('Commit is no longer production branch head; skip stale deployment')
    if shutil.disk_usage(ROOT).free < 3 * 1024 ** 3:
        raise RuntimeError('Less than 3 GiB free; image load deferred')
    if subprocess.run(['docker', 'load', '--quiet'], stdin=sys.stdin.buffer, stdout=subprocess.DEVNULL).returncode:
        raise RuntimeError('Image transfer/load failed')
    image = docker('GET', '/images/9router-ci:' + sha + '/json')
    labels = image['Config'].get('Labels') or {}
    if labels.get('org.opencontainers.image.revision') != sha or labels.get('org.opencontainers.image.source') != 'https://github.com/' + REPOSITORY:
        raise RuntimeError('Image provenance differs from checked commit')
    old = docker('GET', '/containers/' + NAME + '/json')
    if old['Image'] == image['Id']:
        healthy(NAME)
        print('Already deployed: ' + sha)
        return
    if set(old['NetworkSettings']['Networks']) != {NETWORK} or old['HostConfig'].get('PortBindings'):
        raise RuntimeError('Unexpected runtime network; deployment requires review')
    mounts = old.get('Mounts') or []
    if len(mounts) != 1 or any(m.get('Type') != 'bind' or m.get('Source') != str(DATA) or m.get('Destination') != '/app/data' or not m.get('RW') for m in mounts):
        raise RuntimeError('Unexpected data mounts; deployment requires review')
    if any(old['Config'].get(key) != image['Config'].get(key) for key in ['Entrypoint', 'Cmd']):
        raise RuntimeError('Startup contract changed; deployment requires review')
    assert_idle(DATA / DB)
    tag = '9router-ci:' + sha
    test_name = '9router-ci-check-' + sha[:12]
    with tempfile.TemporaryDirectory(prefix='9router-ci-') as tmp:
        trial = Path(tmp) / 'data'
        copy_data(DATA, trial)
        before = snapshot(trial / DB)
        files = file_snapshot(trial)
        try:
            create_start(test_name, configuration(old, tag, trial, rehearsal=True))
            healthy(test_name)
            docker('POST', '/containers/' + test_name + '/stop?t=30')
            preserved(before, snapshot(trial / DB))
            if file_snapshot(trial) != files:
                raise RuntimeError('Candidate changed stored files; release rejected')
        finally:
            docker('DELETE', '/containers/' + test_name + '?force=true')
    if current_head() != sha:
        raise RuntimeError('Newer commit arrived during checks; release superseded')
    release = STATE / (sha + '-' + str(time.time_ns()))
    release.mkdir(exist_ok=True, mode=0o700)
    previous = '9router-before-' + sha[:12]
    stopped = renamed = created = admitted = False
    try:
        receipt(STATE / 'pending.json', {'commit': sha, 'previous': previous, 'phase': 'preparing-cutover'})
        docker('POST', '/containers/' + NAME + '/stop?t=30')
        stopped = True
        assert_idle(DATA / DB)
        copy_data(DATA, release / 'backup')
        before = snapshot(DATA / DB)
        files = file_snapshot(DATA)
        docker('POST', '/containers/' + NAME + '/rename?name=' + previous)
        renamed = True
        docker('POST', '/containers/' + previous + '/update', {'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}})
        config = configuration(old, tag, DATA)
        config['Labels'] = {**(config.get('Labels') or {}), 'org.opencontainers.image.revision': sha}
        docker('POST', '/containers/create?name=' + NAME, config)
        created = True
        docker('POST', '/containers/' + NAME + '/start')
        healthy(NAME)
        preserved(before, snapshot(DATA / DB))
        if file_snapshot(DATA) != files:
            raise RuntimeError('Startup changed stored files; release rejected')
        receipt(STATE / 'pending.json', {'commit': sha, 'previous': previous, 'phase': 'network-attach'})
        docker('POST', '/networks/none/disconnect', {'Container': NAME})
        # An attachment may succeed even if its acknowledgement is lost.
        admitted = True
        docker('POST', '/networks/' + NETWORK + '/connect', {'Container': NAME, 'EndpointConfig': {'Aliases': [NAME]}})
        docker('POST', '/containers/' + NAME + '/update', {'RestartPolicy': old['HostConfig']['RestartPolicy']})
        healthy(NAME)
        receipt(release / 'result.json', {'commit': sha, 'image': image['Id'], 'previous': previous, 'status': 'deployed'})
        (STATE / 'pending.json').unlink()
        print('Deployed: ' + sha)
    except Exception:
        if admitted:
            raise RuntimeError('Post-cutover check failed; service/data retained for review') from None
        if created:
            docker('DELETE', '/containers/' + NAME + '?force=true')
            shutil.rmtree(DATA)
            shutil.copytree(release / 'backup', DATA)
        if renamed:
            docker('POST', '/containers/' + previous + '/rename?name=' + NAME)
        if stopped:
            docker('POST', '/containers/' + NAME + '/update', {'RestartPolicy': old['HostConfig']['RestartPolicy']})
            docker('POST', '/containers/' + NAME + '/start')
        (STATE / 'pending.json').unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sha = validate_revision(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
        STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (STATE / 'deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            deploy(sha)
    except Exception as error:
        print('Deployment stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
