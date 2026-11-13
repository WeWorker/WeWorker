"""Bounded, read-only history of real exploration artifacts. No restore operation."""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from webwright.server.records import atomic_write_json
from webwright.server.artifact_workspace import artifact_output_dir, current_artifact_path, safe_directory

MAX_BYTES = 512 * 1024
OMIT_DIRS = {'.server', '.git', 'node_modules', '.venv', '__pycache__', 'debug', 'attachments'}
OMIT_FILES = {'trajectory.json', 'task.json', 'runtime.json', 'runtime_errors.jsonl',
              'checkpoint.json', 'control.json', 'browser_attention.json'}


def safe_path(file: Path) -> bool:
    return safe_directory(file)


def snapshot(file: Path) -> dict:
    try:
        if not safe_path(file) or (file.exists() and not file.is_file()):
            return {'state': 'unavailable'}
        stat = file.stat()
        meta = {'size': stat.st_size, 'modifiedAt': stat.st_mtime_ns / 1_000_000}
        if stat.st_size > MAX_BYTES:
            return {'state': 'too_large', **meta}
        with file.open('rb') as stream:
            raw = stream.read(MAX_BYTES + 1)
        after = file.stat()
        if (stat.st_size, stat.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            return {'state': 'unavailable', **meta}
        if len(raw) > MAX_BYTES:
            return {'state': 'too_large', **meta}
        meta['hash'] = hashlib.sha256(raw).hexdigest()
        if b'\0' in raw:
            return {'state': 'binary', **meta}
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            return {'state': 'binary', **meta}
        if text.count('\n') >= 20_000:
            return {'state': 'too_large', **meta}
        return {'state': 'text', 'text': text, **meta}
    except FileNotFoundError:
        return {'state': 'missing'}
    except OSError:
        return {'state': 'unavailable'}


def comparable(value):
    return value['state'] in {'text', 'missing'}


def diff_lines(before, after):
    a, b = before.split('\n') if before else [], after.split('\n') if after else []
    rows, added, removed = [], 0, 0
    if (len(a) + 1) * (len(b) + 1) > 500_000:
        operations = [('replace', 0, len(a), 0, len(b))]
    else:
        operations = difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    for kind, i, j, k, l in operations:
        if kind == 'equal':
            rows.extend({'kind': 'same', 'beforeLine': x + 1, 'afterLine': k + x - i + 1, 'text': a[x]} for x in range(i, j))
        else:
            rows.extend({'kind': 'remove', 'beforeLine': x + 1, 'text': a[x]} for x in range(i, j))
            rows.extend({'kind': 'add', 'afterLine': x + 1, 'text': b[x]} for x in range(k, l))
            removed += j - i
            added += l - k
    return {'rows': rows, 'added': added, 'removed': removed}


def operation(file):
    before, after = file['before']['state'], file['after']['state']
    if 'unavailable' in (before, after):
        return 'unknown'
    return 'delete' if after == 'missing' else 'create' if before == 'missing' else 'edit'


def summary(record):
    files = [] if record['status'] == 'recording' else record['files']
    return {**{k: v for k, v in record.items() if k not in {'files', 'scanComplete'}},
            'files': [{'path': f['path'], 'operation': operation(f), 'added': f['added'], 'removed': f['removed'],
                       'comparable': comparable(f['before']) and comparable(f['after']),
                       'size': f['after'].get('size', f['before'].get('size')), 'state': f['after']['state']} for f in files],
            'fileCount': len(files), 'added': sum(f['added'] for f in files), 'removed': sum(f['removed'] for f in files)}


class FileChangeJournal:
    def __init__(self, root: Path):
        self.root = root.absolute()
        self.directory = self.root / '.server' / 'file-changes'

    def _scan(self):
        files, complete, total, visited = {}, True, 0, 0
        start = time.monotonic()
        files_root = artifact_output_dir(self.root)
        if not safe_path(files_root):
            return {}, False
        def onerror(_):
            nonlocal complete
            complete = False
        for folder, dirs, names in os.walk(files_root, followlinks=False, onerror=onerror):
            dirs[:] = sorted(d for d in dirs if d not in OMIT_DIRS and safe_path(Path(folder) / d))
            for name in sorted(names):
                visited += 1
                if visited > 4000 or len(files) >= 512 or total >= 16 * 1024 * 1024 or time.monotonic() - start > 1:
                    return files, False
                file = Path(folder) / name
                if (file.parent == files_root and name in OMIT_FILES) or not safe_path(file):
                    continue
                value = snapshot(file)
                if value['state'] == 'unavailable':
                    complete = False
                    continue
                files[str(file)] = value
                total += len(value.get('text', '').encode('utf-8'))
        return files, complete

    def _save(self, record):
        if not safe_path(self.directory):
            raise ValueError('Unsafe change history directory')
        atomic_write_json(self.directory / (record['id'] + '.json'), record)
        atomic_write_json(self.directory / (record['id'] + '.meta.json'), summary(record))

    def begin(self, run_id: str, step: int):
        files, complete = self._scan()
        record = {'id': uuid4().hex, 'workId': self.root.name, 'turnId': run_id, 'toolCallId': f'{run_id}:{step}',
                  'tool': 'exploration_action', 'source': 'tool', 'step': step, 'status': 'recording',
                  'startedAt': datetime.now(timezone.utc).isoformat(), 'scanComplete': complete,
                  'files': [{'path': name, 'before': value, 'after': {'state': 'unavailable'}, 'added': 0, 'removed': 0} for name, value in files.items()]}
        self._save(record)
        return record

    def finish(self, record, *, failed=False):
        after, complete = self._scan()
        before = {f['path']: f['before'] for f in record['files']}
        files = []
        for name in sorted(before.keys() | after.keys()):
            old = before.get(name, {'state': 'missing' if record['scanComplete'] else 'unavailable'})
            current = after.get(name) or snapshot(Path(name))
            if old == current or (old.get('hash') and old.get('hash') == current.get('hash') and old['state'] == current['state']):
                continue
            counts = diff_lines(old.get('text', ''), current.get('text', '')) if comparable(old) and comparable(current) else {'added': 0, 'removed': 0}
            files.append({'path': name, 'before': old, 'after': current, 'added': counts['added'], 'removed': counts['removed']})
        record.update(files=files, status=('failed' if failed else 'completed') if files else 'unchanged', completedAt=datetime.now(timezone.utc).isoformat())
        if not complete or not record['scanComplete']:
            record['note'] = '扫描受容量或文件访问限制，记录可能不完整。'
        self._save(record)
        return summary(record) if files else None

    def list(self):
        if not safe_path(self.directory):
            return []
        records = []
        for file in self.directory.glob('*.meta.json'):
            if safe_path(file):
                record = json.loads(file.read_text(encoding='utf-8'))
                for entry in record['files']:
                    entry['path'] = str(current_artifact_path(self.root, Path(entry['path'])))
                if record['status'] != 'unchanged':
                    records.append(record)
        return sorted(records, key=lambda r: (r['startedAt'], r['id']))

    def detail(self, record_id, index=0):
        if not re.fullmatch(r'[a-f0-9]{32}', record_id) or type(index) is not int or not 0 <= index <= 10_000:
            raise ValueError('Invalid change record')
        path = self.directory / (record_id + '.json')
        if not safe_path(path):
            raise ValueError('Unsafe change record')
        record = json.loads(path.read_text(encoding='utf-8'))
        if index >= len(record['files']):
            raise FileNotFoundError('File record not found')
        file = record['files'][index]
        file['path'] = str(current_artifact_path(self.root, Path(file['path'])))
        return {**summary(record), 'fileIndex': index, 'file': {**file, 'operation': operation(file)},
                'diff': diff_lines(file['before'].get('text', ''), file['after'].get('text', '')) if comparable(file['before']) and comparable(file['after']) else None}

    def artifact(self, record_id, index=0):
        file = Path(self.detail(record_id, index)['file']['path'])
        if not file.is_relative_to(artifact_output_dir(self.root)) or not safe_path(file) or not file.is_file():
            raise FileNotFoundError('Artifact not available')
        return file
