#!/usr/bin/env python3
"""Receive one CI-built image through a restricted SSH key; preserve live data."""
import copy
from contextlib import closing
import fcntl
from functools import cache
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
import tarfile
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
SOURCE = 'https://github.com/' + REPOSITORY
SOURCE_LABEL = 'org.opencontainers.image.source'
REVISION_LABEL = 'org.opencontainers.image.revision'
BASE_LABEL = 'io.9router.upstream.revision'
GIB = 1024 ** 3
RESERVE = 3 * GIB
BACKUP_BUDGET = 2 * GIB
MAX_ROLLBACKS = 5


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(120)
        self.sock.connect('/var/run/docker.sock')


def docker_request(method, path, body=None, missing_ok=False):
    conn = DockerConnection('localhost', timeout=120)
    try:
        conn.request(method, path, json.dumps(body) if body is not None else None,
                     {'Content-Type': 'application/json'})
        response = conn.getresponse()
        raw = response.read()
    finally:
        conn.close()
    if missing_ok and response.status == 404:
        return None
    if response.status >= 400:
        # Docker errors may contain runtime configuration; retain no response body.
        raise RuntimeError(f'Docker operation failed: {method} {path} ({response.status})')
    return json.loads(raw) if raw else None


@cache
def docker_api():
    version = docker_request('GET', '/version')
    minimum = tuple(map(int, version['MinAPIVersion'].split('.')))
    maximum = tuple(map(int, version['ApiVersion'].split('.')))
    api = max((1, 41), minimum)
    if api > maximum:
        raise RuntimeError('Docker Engine API is too old for deployment')
    return '/v' + '.'.join(map(str, api))


def docker(method, path, body=None, missing_ok=False):
    return docker_request(method, docker_api() + path, body, missing_ok)


def validate_revision(value):
    if not re.fullmatch('[0-9a-f]{40}', value):
        raise ValueError('Expected an immutable Git commit SHA')
    return value


def release_command(value):
    match = re.fullmatch(r'([0-9a-f]{40}) (sha256:[0-9a-f]{64}) ([1-9][0-9]{0,11}) ([0-9a-f]{40}) ([0-9a-f]{64})', value)
    if not match:
        raise ValueError('Expected revision, image ID, image bytes, official base and receiver checksum')
    sha, image_id, size, base, receiver = match.groups()
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != receiver:
        raise RuntimeError('Install the exact checked receiver before release')
    return sha, image_id, int(size), base


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
    sync_directory(path.parent)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
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


def require_space(path, extra=0):
    if shutil.disk_usage(path).free < RESERVE + extra:
        raise RuntimeError(f'Insufficient space on {path} for deployment and the 3 GiB reserve')


def tree_bytes(path):
    return sum(entry.stat().st_size for entry in path.rglob('*')
               if not entry.is_symlink() and entry.is_file())


def check_snapshots():
    size = tree_bytes(DATA)
    if tree_bytes(STATE) + size > BACKUP_BUDGET:
        raise RuntimeError('Local deployment backup budget exceeded; archive older snapshots before retrying')
    # Budget for a backup, migration writes, and a staged restore before cutting over.
    if DATA.stat().st_dev == STATE.stat().st_dev:
        require_space(STATE, 3 * size)
    else:
        require_space(STATE, size)
        require_space(DATA, 2 * size)
    return size


def image_revision(image):
    labels = (image.get('Config') or {}).get('Labels') or {}
    sha = labels.get(REVISION_LABEL, '')
    if labels.get(SOURCE_LABEL) == SOURCE and re.fullmatch('[0-9a-f]{40}', sha):
        return sha
    return None


def completed_releases():
    releases = []
    for path in STATE.glob('*/result.json'):
        directory = re.fullmatch(r'([0-9a-f]{40})-([0-9]+)', path.parent.name)
        if not directory or path.parent.is_symlink() or path.is_symlink():
            continue
        try:
            result = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        sha, order = directory.groups()
        if (isinstance(result, dict) and result.get('status') == 'deployed'
                and result.get('commit') == sha and result.get('previous') == '9router-before-' + sha[:12]):
            releases.append((int(order), result))
    return sorted(releases, key=lambda item: item[0], reverse=True)


def rollback_plan():
    releases = completed_releases()
    verified, unknown = [], []
    for container in docker('GET', '/containers/json?all=1'):
        if not any(re.fullmatch(r'/9router-before-[0-9a-f]{12}', n) for n in container.get('Names', [])):
            continue
        old = docker('GET', '/containers/' + container['Id'] + '/json', missing_ok=True)
        if old is None:
            continue
        name = old['Name'].lstrip('/')
        image = docker('GET', '/images/' + old['Image'] + '/json', missing_ok=True) or {}
        revision = image_revision(image)
        matching = []
        for order, result in releases:
            if result.get('previous') != name:
                continue
            # Legacy names use the incoming revision. Match the outgoing image to its
            # earlier deploy receipt if the cutover predates explicit predecessor IDs.
            if 'previousContainer' in result:
                matches = result['previousContainer'] == old['Id'] and result.get('previousImage') == old['Image']
            else:
                matches = any(ts < order and prior.get('image') == old['Image'] and prior['commit'] == revision
                              for ts, prior in releases)
            if matches:
                matching.append(order)
        if (len(matching) != 1 or not revision or image.get('Id') != old['Image']
                or old.get('State', {}).get('Status') != 'exited'
                or old.get('HostConfig', {}).get('RestartPolicy', {}).get('Name') != 'no'):
            unknown.append(name)
            continue
        verified.append((matching[0], old['Id'], name))
    verified.sort(reverse=True)
    return verified[:MAX_ROLLBACKS], verified[MAX_ROLLBACKS:], sorted(unknown)


def remove_image(sha, expected_id, referenced):
    tag = '9router-ci:' + sha
    image = docker('GET', '/images/' + tag + '/json', missing_ok=True)
    if (image and image.get('Id') == expected_id and expected_id not in referenced
            and image_revision(image) == sha):
        docker('DELETE', '/images/' + tag + '?force=false', missing_ok=True)


def settle_import():
    marker = STATE / 'import.json'
    if not marker.exists():
        return
    record = json.loads(marker.read_text())
    sha = validate_revision(record['commit'])
    image_id = record['image']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise RuntimeError('Interrupted Docker import requires review')
    tag = docker('GET', '/images/9router-ci:' + sha + '/json', missing_ok=True)
    if tag and (tag.get('Id') != image_id or image_revision(tag) != sha):
        raise RuntimeError('Interrupted Docker import differs from its receipt')
    referenced = {c['ImageID'] for c in docker('GET', '/containers/json?all=1')}
    remove_image(sha, image_id, referenced)
    marker.unlink()
    sync_directory(STATE)


def retention():
    if (STATE / 'pending.json').exists():
        return
    try:
        _, retired, unknown = rollback_plan()
        if unknown:
            print('Rollbacks needing review: ' + ', '.join(unknown), file=sys.stderr)
        for _, container_id, _ in retired:
            try:
                docker('DELETE', '/containers/' + container_id + '?force=false&v=false', missing_ok=True)
            except RuntimeError as error:
                print('Rollback cleanup deferred: ' + str(error), file=sys.stderr)
        referenced = {c['ImageID'] for c in docker('GET', '/containers/json?all=1')}
        checked = {(result['commit'], result['image']) for _, result in completed_releases()}
        for image in docker('GET', '/images/json'):
            image_id = image['Id']
            if image_id in referenced:
                continue
            for tag in image.get('RepoTags') or []:
                sha = tag.removeprefix('9router-ci:')
                if tag.startswith('9router-ci:') and (sha, image_id) in checked:
                    try:
                        remove_image(sha, image_id, referenced)
                    except RuntimeError as error:
                        print('Image cleanup deferred: ' + str(error), file=sys.stderr)
    except Exception as error:
        print('Retention deferred: ' + str(error), file=sys.stderr)


def remove_unmounted_rehearsals():
    mounted = {Path(mount['Source']) for c in docker('GET', '/containers/json?all=1')
               for mount in c.get('Mounts') or [] if mount.get('Source')}
    for path in STATE.glob('.9router-rehearsal-*'):
        if (path.is_dir() and not path.is_symlink() and path.stat().st_uid == os.geteuid()
                and not any(source == path or path in source.parents for source in mounted)):
            shutil.rmtree(path)


def archive_candidates():
    keep, retire, unknown = rollback_plan()
    occupied = {row[2] for row in keep + retire} | set(unknown)
    active = docker('GET', '/containers/' + NAME + '/json')['Image']
    for order, result in completed_releases():
        if result['previous'] not in occupied and result['image'] != active:
            release = STATE / f"{result['commit']}-{order}"
            if (release / 'backup').is_dir() and not (release / 'backup').is_symlink():
                yield release


def compare_archive(archive, release, tar):
    backup = release / 'backup'
    expected = {'backup', *(str(path.relative_to(release)) for path in backup.rglob('*'))}
    with tarfile.open(archive, 'r|gz') as stream:
        for member in stream:
            if member.name not in expected:
                raise RuntimeError('Unexpected or duplicate entry in the backup archive')
            expected.remove(member.name)
    if expected:
        raise RuntimeError('The backup archive is incomplete')
    subprocess.run(tar + ['-dzf', str(archive), '-C', str(release), 'backup'],
                   check=True, timeout=300)


def archive_retired(destination):
    if (STATE / 'pending.json').exists():
        raise RuntimeError('Resolve pending recovery before archiving')
    if (not destination.is_absolute() or destination.is_symlink() or not destination.is_mount()
            or destination.stat().st_dev == STATE.stat().st_dev):
        raise RuntimeError('Use a dedicated private archive mount on a separate filesystem')
    private = destination / '9router-ci'
    private.mkdir(mode=0o700, exist_ok=True)
    if private.is_symlink() or private.stat().st_uid != os.geteuid() or private.stat().st_mode & 0o077:
        raise RuntimeError('Archive directory must be private and owned by the operator')
    for release in archive_candidates():
        result_path = release / 'result.json'
        result = json.loads(result_path.read_text())
        archive = private / (release.name + '.tar.gz')
        temporary = archive.with_suffix('.tmp')
        if archive.is_symlink() or temporary.is_symlink():
            raise RuntimeError('Unexpected link in the archive directory')
        tar = ['tar', '--acls', '--xattrs', '--numeric-owner']
        newly_verified = False
        if not archive.exists():
            try:
                subprocess.run(tar + ['-czf', str(temporary), '-C', str(release), 'backup'],
                               check=True, timeout=300)
                with temporary.open('rb') as stream:
                    os.fsync(stream.fileno())
                compare_archive(temporary, release, tar)
                temporary.rename(archive)
                sync_directory(private)
                newly_verified = True
            finally:
                temporary.unlink(missing_ok=True)
        with archive.open('rb') as stream:
            digest = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        checksum = digest.hexdigest()
        if not newly_verified:
            compare_archive(archive, release, tar)
        receipt(result_path, {**result, 'backupArchive': archive.name, 'backupSha256': checksum})
        shutil.rmtree(release / 'backup')
        sync_directory(release)
        print('Archived verified backup: ' + archive.name)


def deploy(sha, image_id=None, image_size=0, base=None):
    if (STATE / 'pending.json').exists():
        raise RuntimeError('Previous cutover requires review; current data preserved')
    if current_head() != sha:
        raise RuntimeError('Commit is no longer production branch head; skip stale deployment')
    settle_import()
    prior = docker('GET', '/images/9router-ci:' + sha + '/json', missing_ok=True)
    if prior and prior['Id'] != image_id:
        raise RuntimeError('The checked release tag already refers to a different image')
    remove_unmounted_rehearsals()
    data_size = check_snapshots()
    docker_root = Path(docker('GET', '/info')['DockerRootDir'])
    # Allow for both unpacked image data and Docker import staging.
    extra = 2 * image_size if not prior else image_size
    if docker_root.stat().st_dev == STATE.stat().st_dev:
        extra += data_size
    if docker_root.stat().st_dev == DATA.stat().st_dev:
        extra += 2 * data_size
    require_space(docker_root, extra)
    marker = STATE / 'import.json'
    if not prior:
        receipt(marker, {'commit': sha, 'image': image_id})
    try:
        if subprocess.run(['docker', 'load', '--quiet'], stdin=sys.stdin.buffer, stdout=subprocess.DEVNULL).returncode:
            raise RuntimeError('Image transfer/load failed')
        deploy_loaded(sha, image_id, base)
    except Exception:
        if not prior and not (STATE / 'pending.json').exists():
            try:
                settle_import()
            except Exception as error:
                print('Failed image cleanup deferred: ' + str(error), file=sys.stderr)
        raise
    marker.unlink(missing_ok=True)
    sync_directory(STATE)
    retention()


def deploy_loaded(sha, image_id, base):
    image = docker('GET', '/images/9router-ci:' + sha + '/json')
    if (image_revision(image) != sha or image['Id'] != image_id
            or image['Config']['Labels'].get(BASE_LABEL) != base):
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
    check_snapshots()
    tag = '9router-ci:' + sha
    test_name = '9router-ci-check-' + sha[:12]
    with tempfile.TemporaryDirectory(prefix='.9router-rehearsal-', dir=STATE) as tmp:
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
            docker('DELETE', '/containers/' + test_name + '?force=true', missing_ok=True)
    if current_head() != sha:
        raise RuntimeError('Newer commit arrived during checks; release superseded')
    check_snapshots()
    release = STATE / (sha + '-' + str(time.time_ns()))
    release.mkdir(exist_ok=True, mode=0o700)
    previous = '9router-before-' + sha[:12]
    stopped = renamed = created = admitted = False
    try:
        receipt(STATE / 'pending.json', {'commit': sha, 'previous': previous, 'phase': 'preparing-cutover'})
        docker('POST', '/containers/' + NAME + '/stop?t=30')
        stopped = True
        assert_idle(DATA / DB)
        check_snapshots()
        staging = release / 'backup.tmp'
        try:
            copy_data(DATA, staging)
            staging.rename(release / 'backup')
        finally:
            if staging.exists():
                shutil.rmtree(staging)
        before = snapshot(DATA / DB)
        files = file_snapshot(DATA)
        docker('POST', '/containers/' + NAME + '/rename?name=' + previous)
        renamed = True
        docker('POST', '/containers/' + previous + '/update', {'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}})
        config = configuration(old, tag, DATA)
        config['Labels'] = {**(config.get('Labels') or {}), SOURCE_LABEL: SOURCE, REVISION_LABEL: sha, BASE_LABEL: base}
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
        receipt(release / 'result.json', {'commit': sha, 'image': image['Id'], 'upstreamBase': base,
                                         'previous': previous, 'previousContainer': old['Id'],
                                         'previousImage': old['Image'], 'status': 'deployed'})
        (STATE / 'pending.json').unlink()
        print('Deployed: ' + sha)
    except Exception:
        if admitted:
            raise RuntimeError('Post-cutover check failed; service/data retained for review') from None
        if created:
            docker('DELETE', '/containers/' + NAME + '?force=true')
            work = Path(tempfile.mkdtemp(prefix='.9router-restore-', dir=STATE if STATE.stat().st_dev == DATA.stat().st_dev else DATA.parent))
            shutil.copytree(release / 'backup', work / 'restored')
            DATA.rename(work / 'failed')
            try:
                (work / 'restored').rename(DATA)
            except OSError:
                (work / 'failed').rename(DATA)
                raise
            shutil.rmtree(work)
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
        command = os.environ.get('SSH_ORIGINAL_COMMAND')
        if command is None and sys.argv[1:] == ['--retention-plan']:
            keep, retire, unknown = rollback_plan()
            print(json.dumps({'keep': [row[2] for row in keep], 'retire': [row[2] for row in retire],
                              'unknown': unknown, 'pending': (STATE / 'pending.json').exists()}, indent=2))
            sys.exit(0)
        archive = command is None and len(sys.argv) == 3 and sys.argv[1] == '--archive-retired'
        release = None if archive else release_command(command or '')
        STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (STATE / 'deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if archive:
                archive_retired(Path(sys.argv[2]))
            else:
                deploy(*release)
    except Exception as error:
        print('Deployment stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
