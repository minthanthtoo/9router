import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('patch_export', Path(__file__).with_name('export.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExportTests(unittest.TestCase):
    def test_replay_preserves_dirty_worktree_index_and_binary_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'repo'
            repo.mkdir()
            def git(*args):
                return module.git(repo, *args)
            git('init', '-q')
            git('config', 'user.name', 'Patch test')
            git('config', 'user.email', 'patch@example.invalid')
            (repo / 'file').write_text('base\n')
            git('add', '.')
            git('commit', '-qm', 'base')
            base = git('rev-parse', 'HEAD').decode().strip()
            (repo / 'file').write_text('changed\n')
            (repo / 'binary file').write_bytes(b'\0\xff\x10')
            git('add', '.')
            git('commit', '-qm', 'feature')
            (repo / 'file').write_text('staged\n')
            git('add', 'file')
            (repo / 'file').write_text('unsaved\n')
            before = git('diff', '--cached'), git('diff'), git('rev-parse', 'HEAD')
            output = Path(tmp) / 'export'
            result = module.export(repo, base, 'HEAD', output, True)
            self.assertTrue(result['verified'])
            self.assertEqual(len(result['patches']), 1)
            self.assertEqual(before, (git('diff', '--cached'), git('diff'), git('rev-parse', 'HEAD')))
            self.assertEqual(json.loads((output / 'series.json').read_text())['base'], base)
            with self.assertRaises(FileExistsError):
                module.export(repo, base, 'HEAD', output, True)
            with self.assertRaises(subprocess.CalledProcessError):
                module.export(repo, 'missing-base', 'HEAD', Path(tmp) / 'invalid', True)

    def test_catalog_references_exist_and_dependencies_are_ordered(self):
        repo = Path(__file__).resolve().parents[2]
        config = json.loads((repo / 'patches/upstream.json').read_text())
        seen = set()
        for feature in config['features']:
            self.assertNotIn(feature['id'], seen)
            self.assertTrue(set(feature['depends_on']) <= seen)
            for name in feature['entrypoints'] + feature['tests']:
                self.assertTrue((repo / name).is_file(), name)
                tracked = subprocess.run(['git', '-C', str(repo), 'ls-files', '--error-unmatch', name], capture_output=True)
                self.assertEqual(tracked.returncode, 0, f'Catalogue references an untracked file: {name}')
            seen.add(feature['id'])


if __name__ == '__main__':
    unittest.main()
