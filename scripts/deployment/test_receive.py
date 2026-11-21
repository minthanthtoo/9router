from contextlib import closing
import copy
import hashlib
import io
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import receive


class DeploymentSafety(unittest.TestCase):
    def test_revision_rejects_shell_and_ref_input(self):
        for value in ['', 'master', 'a' * 39, 'A' * 40, 'a' * 40 + ';id', '../data']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                receive.validate_revision(value)
        self.assertEqual(receive.validate_revision('a' * 40), 'a' * 40)

    def test_release_command_requires_the_exact_receiver_and_positive_image_size(self):
        revision = 'a' * 40
        base = 'c' * 40
        receiver = hashlib.sha256(Path(receive.__file__).read_bytes()).hexdigest()
        archive = 'd' * 64
        self.assertEqual(receive.release_command(f'{revision} 42 {base} {receiver} {archive}'),
                         (revision, 42, base, archive))
        with self.assertRaisesRegex(RuntimeError, 'exact checked receiver'):
            receive.release_command(f'{revision} 42 {base} ' + 'e' * 64 + f' {archive}')
        with self.assertRaises(ValueError):
            receive.release_command(f'{revision} 0 {base} {receiver} {archive}')

    def test_streamed_archive_checksum_is_verified_without_buffering_the_archive(self):
        payload = b'compressed image stream'

        class Pipe:
            def __init__(self):
                self.written = bytearray()

            def write(self, block):
                self.written.extend(block)

            def close(self):
                pass

        class Process:
            def __init__(self):
                self.stdin = Pipe()

            def wait(self):
                return 0

            def poll(self):
                return 0

            def terminate(self):
                raise AssertionError('successful import should not be terminated')

        process = Process()
        stdin = type('Input', (), {'buffer': io.BytesIO(payload)})()
        with patch.object(receive.subprocess, 'Popen', return_value=process), \
             patch.object(receive.sys, 'stdin', stdin):
            receive.load_checked_image(hashlib.sha256(payload).hexdigest())
        self.assertEqual(bytes(process.stdin.written), payload)

        process = Process()
        stdin = type('Input', (), {'buffer': io.BytesIO(payload)})()
        with patch.object(receive.subprocess, 'Popen', return_value=process), \
             patch.object(receive.sys, 'stdin', stdin), \
             self.assertRaisesRegex(RuntimeError, 'archive checksum mismatch'):
            receive.load_checked_image('e' * 64)

    def test_loaded_image_id_may_be_normalized_by_another_docker_engine(self):
        revision, base = 'a' * 40, 'c' * 40
        imported_id = 'sha256:' + 'b' * 64
        image = {'Id': imported_id, 'Config': {'Labels': {
            receive.SOURCE_LABEL: receive.SOURCE,
            receive.REVISION_LABEL: revision,
            receive.BASE_LABEL: base}}}

        def docker(method, path, body=None, missing_ok=False):
            if path.startswith('/images/'):
                return image
            if path == '/containers/9router/json':
                return {'Image': imported_id}
            raise AssertionError(path)

        with patch.object(receive, 'docker', side_effect=docker), \
             patch.object(receive, 'current_head', return_value=revision), \
             patch.object(receive, 'healthy') as healthy:
            receive.deploy_loaded(revision, base)
        healthy.assert_called_once_with(receive.NAME)

    def test_verified_import_cleanup_uses_labels_not_cross_engine_image_id(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            revision, base = 'a' * 40, 'c' * 40
            actual_id = 'sha256:' + 'b' * 64
            marker = state / 'import.json'
            marker.write_text('{"commit":"' + revision + '","base":"' + base +
                              '","archiveVerified":true,"image":"sha256:' + 'd' * 64 + '"}')
            image = {'Id': actual_id, 'Config': {'Labels': {
                receive.SOURCE_LABEL: receive.SOURCE,
                receive.REVISION_LABEL: revision,
                receive.BASE_LABEL: base}}}
            calls = []

            def docker(method, path, body=None, missing_ok=False):
                calls.append((method, path))
                if path.startswith('/images/'):
                    return image
                if path == '/containers/json?all=1':
                    return []
                return {}

            with patch.object(receive, 'STATE', state), patch.object(receive, 'docker', side_effect=docker):
                receive.settle_import()
            self.assertFalse(marker.exists())
            self.assertIn(('DELETE', '/images/9router-ci:' + revision + '?force=false'), calls)

    def test_unverified_import_with_an_unexpected_image_id_is_retained_for_review(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            revision = 'a' * 40
            marker = state / 'import.json'
            marker.write_text('{"commit":"' + revision + '","archiveVerified":false,"image":"sha256:' + 'c' * 64 + '"}')
            image = {'Id': 'sha256:' + 'b' * 64, 'Config': {'Labels': {
                receive.SOURCE_LABEL: receive.SOURCE,
                receive.REVISION_LABEL: revision}}}
            with patch.object(receive, 'STATE', state), patch.object(receive, 'docker', return_value=image):
                with self.assertRaisesRegex(RuntimeError, 'differs from its receipt'):
                    receive.settle_import()
            self.assertTrue(marker.exists())

    def test_configuration_keeps_runtime_and_isolates_rehearsal(self):
        old = {'Config': {'Env': ['TOKEN=private', 'IMAGE_ADMIN_TEST_WORKER_ENABLED=true'], 'Cmd': ['node', 'custom-server.js']},
               'HostConfig': {'Binds': ['/live:/app/data'], 'Mounts': [{'Source': '/live', 'Target': '/app/data'}], 'NetworkMode': 'live', 'RestartPolicy': {'Name': 'unless-stopped'}, 'PortBindings': {'80': []}}}
        original = copy.deepcopy(old)
        result = receive.configuration(old, 'ci-image', '/trial', rehearsal=True)
        self.assertEqual(old, original)
        self.assertIn('TOKEN=private', result['Env'])
        self.assertIn('IMAGE_ADMIN_TEST_WORKER_ENABLED=false', result['Env'])
        self.assertEqual(result['HostConfig']['Binds'], ['/trial:/app/data'])
        self.assertEqual(result['HostConfig']['NetworkMode'], 'none')
        self.assertNotIn('PortBindings', result['HostConfig'])
        self.assertNotIn('Mounts', result['HostConfig'])
        live = receive.configuration(old, 'ci-image', '/live')
        self.assertEqual(live['Env'], old['Config']['Env'])
        self.assertEqual(live['HostConfig']['Binds'], old['HostConfig']['Binds'])

    def test_preservation_accepts_additions_rejects_loss_and_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.sqlite'
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('create table settings(id integer primary key, data text)')
                db.execute("insert into settings values(1, 'saved')")
            before = receive.snapshot(path)
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('alter table settings add column new_field text')
                db.execute('create table new_table(id integer)')
            receive.preserved(before, receive.snapshot(path))
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("update settings set data='changed'")
            with self.assertRaises(RuntimeError):
                receive.preserved(before, receive.snapshot(path))
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('delete from settings')
            with self.assertRaises(RuntimeError):
                receive.preserved(before, receive.snapshot(path))

    def test_preservation_rejects_values_swapped_between_accounts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.sqlite'
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('create table accounts(id integer primary key, credential text)')
                db.executemany('insert into accounts values(?, ?)', [(1, 'first'), (2, 'second')])
            before = receive.snapshot(path)
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("update accounts set credential=case id when 1 then 'second' else 'first' end")
            with self.assertRaises(RuntimeError):
                receive.preserved(before, receive.snapshot(path))

    def test_idle_refuses_dispatched_or_active_work(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.sqlite'
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('create table imageQuotaRequestSubmissions(outcome text)')
                db.execute('create table adminImageTestRuns(state text)')
                db.execute("insert into imageQuotaRequestSubmissions values('in_flight')")
            with self.assertRaises(RuntimeError):
                receive.assert_idle(path)
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('delete from imageQuotaRequestSubmissions')
                db.execute("insert into adminImageTestRuns values('running')")
            with self.assertRaises(RuntimeError):
                receive.assert_idle(path)
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("update adminImageTestRuns set state='paused'")
            receive.assert_idle(path)

    def test_pending_cutover_and_stale_commit_never_load_image(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(receive, 'STATE', Path(directory)), patch.object(receive.subprocess, 'run') as run:
            (Path(directory) / 'pending.json').write_text('{}')
            with self.assertRaises(RuntimeError):
                receive.deploy('a' * 40)
            run.assert_not_called()
            (Path(directory) / 'pending.json').unlink()
            with patch.object(receive, 'current_head', return_value='b' * 40), self.assertRaises(RuntimeError):
                receive.deploy('a' * 40)
            run.assert_not_called()

    def test_failed_candidate_restores_before_traffic_but_never_after_attachment(self):
        for after_attachment in [False, True]:
            with self.subTest(after_attachment=after_attachment), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                data = root / 'data'
                state = root / 'ci'
                state.mkdir()
                (data / 'db').mkdir(parents=True)
                with closing(sqlite3.connect(data / receive.DB)) as db, db:
                    db.execute('create table settings(id integer)')
                    db.execute('insert into settings values(7)')
                sha = 'a' * 40
                old = {'Id': 'old-container', 'Image': 'old', 'Config': {'Entrypoint': ['/entrypoint.sh'], 'Cmd': ['node'], 'Env': []},
                       'HostConfig': {'Binds': [str(data) + ':/app/data'], 'RestartPolicy': {'Name': 'unless-stopped'}},
                       'Mounts': [{'Type': 'bind', 'Source': str(data), 'Destination': '/app/data', 'RW': True}],
                       'NetworkSettings': {'Networks': {receive.NETWORK: {}}}}
                image_id = 'sha256:' + 'b' * 64
                base, archive = 'c' * 40, 'd' * 64
                image = {'Id': image_id, 'Config': {**old['Config'], 'Labels': {
                    'org.opencontainers.image.revision': sha,
                    'org.opencontainers.image.source': 'https://github.com/' + receive.REPOSITORY,
                    receive.BASE_LABEL: base}}}
                calls = []
                loaded = False
                def fake_docker(method, path, body=None, missing_ok=False):
                    calls.append((method, path))
                    if method == 'GET':
                        if path.startswith('/images/'):
                            return image if loaded else None
                        if path == '/info':
                            return {'DockerRootDir': str(root)}
                        if path == '/containers/json?all=1':
                            return []
                        return old
                    if after_attachment and path == '/networks/' + receive.NETWORK + '/connect':
                        raise RuntimeError('acknowledgement lost')
                    return {}
                def load(_):
                    nonlocal loaded
                    loaded = True
                with patch.object(receive, 'ROOT', root), patch.object(receive, 'DATA', data), patch.object(receive, 'STATE', state), \
                     patch.object(receive, 'current_head', return_value=sha), patch.object(receive, 'docker', side_effect=fake_docker), \
                     patch.object(receive, 'healthy', side_effect=None if after_attachment else [None, RuntimeError('unhealthy')]), \
                     patch.object(receive.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 4 * 1024 ** 3})()), \
                     patch.object(receive, 'load_checked_image', side_effect=load):
                    with self.assertRaises(RuntimeError):
                        receive.deploy(sha, 1, base, archive)
                self.assertIn(('POST', '/containers/9router-before-' + sha[:12] + '/update'), calls)
                self.assertEqual(('POST', '/containers/9router/update') in calls, not after_attachment)
                self.assertEqual((state / 'pending.json').exists(), after_attachment)
                self.assertEqual((state / 'import.json').exists(), after_attachment)
                self.assertEqual(('DELETE', '/containers/9router?force=true') in calls, not after_attachment)
                self.assertEqual(('DELETE', '/images/9router-ci:' + sha + '?force=false') in calls, not after_attachment)
                with closing(sqlite3.connect(data / receive.DB)) as db, db:
                    self.assertEqual(db.execute('select id from settings').fetchone()[0], 7)

    def test_storage_guards_block_before_docker_load(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'data'
            state = Path(directory) / 'ci'
            data.mkdir()
            state.mkdir()
            (data / 'payload').write_bytes(b'synthetic')
            sha = 'a' * 40
            with patch.object(receive, 'DATA', data), patch.object(receive, 'STATE', state), \
                 patch.object(receive, 'current_head', return_value=sha), patch.object(receive, 'docker') as docker, \
                 patch.object(receive, 'load_checked_image') as load:
                docker.side_effect = [None, [], {'DockerRootDir': directory}]
                with patch.object(receive, 'BACKUP_BUDGET', 1), self.assertRaisesRegex(RuntimeError, 'backup budget'):
                    receive.deploy(sha, 1, 'c' * 40, 'd' * 64)
                docker.side_effect = [None, [], {'DockerRootDir': directory}]
                disk = type('Disk', (), {'free': receive.RESERVE + 100})()
                with patch.object(receive.shutil, 'disk_usage', return_value=disk), self.assertRaisesRegex(RuntimeError, '3 GiB reserve'):
                    receive.deploy(sha, 100, 'c' * 40, 'd' * 64)
                load.assert_not_called()

    def test_rollback_plan_joins_legacy_receipts_and_current_container_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            refs = [str(i) * 40 for i in range(8)]
            containers, images = {}, {}
            for i, sha in enumerate(refs):
                image_id = f'image-{i}'
                images[image_id] = {'Id': image_id, 'Config': {'Labels': {
                    receive.SOURCE_LABEL: receive.SOURCE, receive.REVISION_LABEL: sha}}}
                previous = '9router-before-' + sha[:12]
                release = state / (sha + '-' + str(i))
                release.mkdir()
                result = {'commit': sha, 'image': image_id, 'previous': previous, 'status': 'deployed'}
                if not i:
                    continue
                if i == 6:
                    result.update(previousContainer='container-6', previousImage='image-5')
                if i == 7:
                    result.update(previousContainer='different', previousImage='image-6')
                containers[f'container-{i}'] = {
                    'Id': f'container-{i}', 'Name': '/' + previous, 'Image': f'image-{i-1}',
                    'State': {'Status': 'exited'}, 'HostConfig': {'RestartPolicy': {'Name': 'no'}}}
                receive.receipt(release / 'result.json', result)
            first = state / (refs[0] + '-0')
            receive.receipt(first / 'result.json', {'commit': refs[0], 'image': 'image-0',
                            'previous': '9router-before-' + refs[0][:12], 'status': 'deployed'})

            def docker(method, path, missing_ok=False):
                if path == '/containers/json?all=1':
                    return [{'Names': [c['Name']], 'Id': c['Id']} for c in containers.values()]
                if path.startswith('/containers/'):
                    return containers[path.split('/')[2]]
                return images[path.split('/')[2]]

            with patch.object(receive, 'STATE', state), patch.object(receive, 'docker', side_effect=docker):
                keep, retire, unknown = receive.rollback_plan()
                self.assertEqual([c[1] for c in keep], [f'container-{i}' for i in range(6, 1, -1)])
                self.assertEqual([c[1] for c in retire], ['container-1'])
                self.assertEqual(unknown, ['9router-before-' + refs[7][:12]])

    def test_docker_api_uses_the_daemons_supported_minimum(self):
        for minimum, expected in [('1.24', '/v1.41'), ('1.44', '/v1.44')]:
            with self.subTest(minimum=minimum), patch.object(receive, 'docker_request',
                                                             return_value={'MinAPIVersion': minimum, 'ApiVersion': '1.53'}):
                receive.docker_api.cache_clear()
                self.assertEqual(receive.docker_api(), expected)
        receive.docker_api.cache_clear()

    def test_archive_rejects_missing_files_before_removing_the_source(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            backup = release / 'backup'
            backup.mkdir()
            (backup / 'one').write_bytes(b'one')
            (backup / 'two').write_bytes(b'two')
            archive = release / 'backup.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                stream.add(backup, arcname='backup', recursive=False)
                stream.add(backup / 'one', arcname='backup/one')
            with patch.object(receive.subprocess, 'run') as compare:
                with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                    receive.compare_archive(archive, release, ['tar'])
                compare.assert_not_called()
            self.assertEqual((backup / 'two').read_bytes(), b'two')

    def test_backup_uses_sqlite_backup_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'live'
            (source / 'db').mkdir(parents=True)
            with closing(sqlite3.connect(source / receive.DB)) as db, db:
                db.execute('create table settings(id integer)')
                db.execute('insert into settings values(1)')
            (source / 'config.json').write_text('private')
            receive.copy_data(source, root / 'backup')
            self.assertEqual(receive.snapshot(source / receive.DB), receive.snapshot(root / 'backup' / receive.DB))
            self.assertEqual(receive.file_snapshot(source), receive.file_snapshot(root / 'backup'))
            (source / 'db/backups').mkdir()
            (source / 'db/backups/schema-19-to-20.sqlite').write_text('migration recovery copy')
            self.assertEqual(receive.file_snapshot(source), receive.file_snapshot(root / 'backup'))
            (source / 'link').symlink_to('/etc/passwd')
            with self.assertRaises(RuntimeError):
                receive.copy_data(source, root / 'unsafe')


if __name__ == '__main__':
    unittest.main()
