import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing

spec = importlib.util.spec_from_file_location('backup', Path(__file__).parents[2] / 'deploy/backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        (self.state / 'keys').mkdir(parents=True)
        (self.state / 'keys/identity.pem').write_text('test-key-material')
        self.db = sqlite3.connect(self.state / 'vectory.db')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE device(id TEXT PRIMARY KEY, generation INTEGER)')
        self.db.execute("INSERT INTO device VALUES ('device-a', 17)")
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_live_wal_backup_and_restore_preserve_keys_and_generation(self):
        self.assertTrue((self.state / 'vectory.db-wal').exists())
        backup.backup(self.state, self.root / 'copy', 'vectory.db')
        backup.restore(self.root / 'copy', self.root / 'restored')
        with closing(sqlite3.connect(self.root / 'restored/vectory.db')) as db:
            self.assertEqual(db.execute('SELECT generation FROM device').fetchone()[0], 17)
        self.assertEqual((self.root / 'restored/keys/identity.pem').read_text(), 'test-key-material')

    def test_tampered_backup_rejected(self):
        backup.backup(self.state, self.root / 'copy', 'vectory.db')
        (self.root / 'copy/keys/identity.pem').write_text('modified')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            backup.restore(self.root / 'copy', self.root / 'restored')
        self.assertFalse((self.root / 'restored').exists())

    def test_restore_refuses_existing_directory(self):
        backup.backup(self.state, self.root / 'copy', 'vectory.db')
        with self.assertRaisesRegex(ValueError, 'must not exist'):
            backup.restore(self.root / 'copy', self.state)

    def test_unlisted_file_rejected(self):
        backup.backup(self.state, self.root / 'copy', 'vectory.db')
        (self.root / 'copy/extra').write_text('unexpected')
        with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
            backup.restore(self.root / 'copy', self.root / 'restored')

    def test_rotation_during_snapshot_aborts(self):
        original = backup.extras
        calls = 0
        def unstable(state):
            nonlocal calls
            calls += 1
            result = original(state)
            if calls > 1:
                result['keys/new-key'] = 'changed'
            return result
        backup.extras = unstable
        try:
            with self.assertRaisesRegex(ValueError, 'changed during backup'):
                backup.backup(self.state, self.root / 'copy', 'vectory.db')
            self.assertFalse((self.root / 'copy').exists())
        finally:
            backup.extras = original


if __name__ == '__main__':
    unittest.main()
