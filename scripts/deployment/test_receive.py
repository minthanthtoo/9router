from contextlib import closing
import copy
from pathlib import Path
import sqlite3
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
                old = {'Image': 'old', 'Config': {'Entrypoint': ['/entrypoint.sh'], 'Cmd': ['node'], 'Env': []},
                       'HostConfig': {'Binds': [str(data) + ':/app/data'], 'RestartPolicy': {'Name': 'unless-stopped'}},
                       'Mounts': [{'Type': 'bind', 'Source': str(data), 'Destination': '/app/data', 'RW': True}],
                       'NetworkSettings': {'Networks': {receive.NETWORK: {}}}}
                image = {'Id': 'new', 'Config': {**old['Config'], 'Labels': {
                    'org.opencontainers.image.revision': sha,
                    'org.opencontainers.image.source': 'https://github.com/' + receive.REPOSITORY}}}
                calls = []
                def fake_docker(method, path, body=None):
                    calls.append((method, path))
                    if method == 'GET':
                        return image if path.startswith('/images/') else old
                    if after_attachment and path == '/networks/' + receive.NETWORK + '/connect':
                        raise RuntimeError('acknowledgement lost')
                    return {}
                class Input:
                    buffer = None
                with patch.object(receive, 'ROOT', root), patch.object(receive, 'DATA', data), patch.object(receive, 'STATE', state), \
                     patch.object(receive, 'current_head', return_value=sha), patch.object(receive, 'docker', side_effect=fake_docker), \
                     patch.object(receive, 'healthy', side_effect=None if after_attachment else [None, RuntimeError('unhealthy')]), \
                     patch.object(receive.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 4 * 1024 ** 3})()), \
                     patch.object(receive.subprocess, 'run', return_value=type('Result', (), {'returncode': 0})()), patch.object(receive.sys, 'stdin', Input()):
                    with self.assertRaises(RuntimeError):
                        receive.deploy(sha)
                self.assertIn(('POST', '/containers/9router-before-' + sha[:12] + '/update'), calls)
                self.assertEqual(('POST', '/containers/9router/update') in calls, not after_attachment)
                self.assertEqual((state / 'pending.json').exists(), after_attachment)
                self.assertEqual(('DELETE', '/containers/9router?force=true') in calls, not after_attachment)
                with closing(sqlite3.connect(data / receive.DB)) as db, db:
                    self.assertEqual(db.execute('select id from settings').fetchone()[0], 7)

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
            (source / 'link').symlink_to('/etc/passwd')
            with self.assertRaises(RuntimeError):
                receive.copy_data(source, root / 'unsafe')


if __name__ == '__main__':
    unittest.main()
