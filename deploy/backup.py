#!/usr/bin/env python3
"""SQLite-supported backup plus required durable keys; never copies a live DB file.

Online backups require a stable immutable key set. Quiesce key rotation, external
artifact writes, and migrations for the operation. Restore only to a new directory
with the server stopped. Treat resulting directories as credential material.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import tempfile
from datetime import datetime, timezone
from contextlib import closing


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def files(root):
    result = []
    if root.exists():
        root_info = root.lstat()
        if root.is_symlink() or getattr(root_info, 'st_file_attributes', 0) & 1024:
            raise ValueError('links/reparse points are forbidden in backup state')
        for p in sorted(root.rglob('*')):
            info = p.lstat()
            if p.is_symlink() or getattr(info, 'st_file_attributes', 0) & 1024:
                raise ValueError('links/reparse points are forbidden in backup state')
            if p.is_file():
                result.append(p)
            elif not p.is_dir():
                raise ValueError('special files are forbidden in backup state')
    return result


def extras(state):
    return {str(p.relative_to(state)).replace('\\', '/'): digest(p)
            for folder in ('keys', 'artifacts') for p in files(state / folder)}


def secure_copy(src, dest):
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(src, dest)
    dest.chmod(0o600)
    with dest.open('r+b') as stream:
        os.fsync(stream.fileno())


def check_db(path):
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('SQLite integrity check failed')
        if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise ValueError('SQLite foreign-key check failed')


def backup(state, destination, database):
    state, destination = state.resolve(), destination.absolute()
    if destination.exists():
        raise ValueError('backup destination must not exist')
    source_db = state / database
    if source_db.is_symlink() or not source_db.is_file():
        raise ValueError('database must be an existing regular file')
    if not (state / 'keys').is_dir():
        raise ValueError('required keys directory missing')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = Path(tempfile.mkdtemp(prefix='.vectory-backup-', dir=destination.parent))
    try:
        before = extras(state)
        if not any(name.startswith('keys/') for name in before):
            raise ValueError('required key material is missing')
        for name in before:
            secure_copy(state / name, temp / name)
        with closing(sqlite3.connect(source_db.as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(temp / database)) as target:
                source.backup(target)
                target.execute('PRAGMA journal_mode=DELETE')
        (temp / database).chmod(0o600)
        check_db(temp / database)
        if before != extras(state):
            raise ValueError('keys/artifacts changed during backup; quiesce rotation and retry')
        manifest = {'format': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                    'database': database, 'files': {**before, database: digest(temp / database)}}
        (temp / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        (temp / 'manifest.json').chmod(0o600)
        os.rename(temp, destination)
    except Exception:
        shutil.rmtree(temp)
        raise


def restore(source, destination):
    source, destination = source.resolve(), destination.absolute()
    if destination.exists():
        raise ValueError('restore destination must not exist; never overwrite live state')
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format') != 1 or not isinstance(manifest.get('files'), dict):
        raise ValueError('unsupported backup manifest')
    actual_files = {p.relative_to(source).as_posix() for p in files(source)} - {'manifest.json'}
    if actual_files != set(manifest['files']):
        raise ValueError('backup file inventory mismatch')
    for name, expected in manifest['files'].items():
        p = Path(name)
        if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:
            raise ValueError('unsafe backup path')
        if digest(source / p) != expected:
            raise ValueError('backup digest mismatch')
    database = manifest['database']
    if database not in manifest['files'] or len(Path(database).parts) != 1:
        raise ValueError('invalid database entry')
    check_db(source / database)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = Path(tempfile.mkdtemp(prefix='.vectory-restore-', dir=destination.parent))
    try:
        for name in manifest['files']:
            secure_copy(source / name, temp / name)
        os.rename(temp, destination)
    except Exception:
        shutil.rmtree(temp)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='action', required=True)
    b = subs.add_parser('backup')
    b.add_argument('--state', type=Path, required=True)
    b.add_argument('--out', type=Path, required=True)
    b.add_argument('--database', default='vectory.db')
    r = subs.add_parser('restore')
    r.add_argument('--from', dest='source', type=Path, required=True)
    r.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.action == 'backup':
        if len(Path(args.database).parts) != 1 or ':' in args.database or '\\' in args.database:
            parser.error('database must be a plain filename')
        backup(args.state, args.out, args.database)
    else:
        restore(args.source, args.out)
    print('Completed. Keep this directory private; verify generation recovery before reconnecting agents.')


if __name__ == '__main__':
    main()
