"""Host-assigned output files, separate from private exploration runtime state."""
from __future__ import annotations

import json
import os
import shutil
from itertools import chain
from pathlib import Path

from webwright.server.records import atomic_write_json

_LOCATION = '.server/artifact-workspace.json'
_PUBLIC_DIRS = {'artifacts', 'screenshots', 'steps'}


def safe_directory(path: Path) -> bool:
    return not any(part.is_symlink() or getattr(part, 'is_junction', lambda: False)()
                   for part in (path, *path.parents))


def artifact_output_dir(output_dir: Path) -> Path:
    """Keep the task's assigned location stable across restarts and resumes."""
    root = output_dir.absolute()
    location = root / _LOCATION
    if not safe_directory(location):
        raise ValueError('Unsafe artifact workspace metadata')
    if not location.exists():
        return root  # Historical or standalone task.
    data = json.loads(location.read_text(encoding='utf-8'))
    directory = Path(data['directory'])
    if (data.get('version') != 1 or not directory.is_absolute()
            or directory.name != root.name or directory.parent.name != 'website-exploration'
            or not safe_directory(directory)):
        raise ValueError('Unsafe exploration artifact directory')
    return directory


def prepare_artifact_output_dir(output_dir: Path) -> Path:
    root = output_dir.absolute()
    directory = artifact_output_dir(root)
    configured = os.environ.get('WEWORKER_USER_FILES_DIR', '').strip()
    if directory == root and configured:
        directory = Path(configured).expanduser().absolute() / 'website-exploration' / root.name
    if not safe_directory(directory):
        raise ValueError('Exploration artifact directory must not use symbolic links or junctions')
    directory.mkdir(parents=True, exist_ok=True)
    if directory != root and not (root / _LOCATION).exists():
        # Upgrade a resumed legacy task once. Preserve originals and never overwrite
        # an existing user file; runtime state and attachments stay in the service root.
        sources = chain([root / 'script.py'], *((root / name).rglob('*') for name in sorted(_PUBLIC_DIRS)))
        for source in sources:
            relative = source.relative_to(root)
            if not (relative.parts[0] in _PUBLIC_DIRS or relative == Path('script.py')):
                continue
            if not safe_directory(source) or not source.is_file():
                continue
            destination = directory / relative
            if not safe_directory(destination):
                raise ValueError('Unsafe exploration artifact destination')
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                with source.open('rb') as reader, destination.open('xb') as writer:
                    shutil.copyfileobj(reader, writer)
        atomic_write_json(root / _LOCATION, {'version': 1, 'directory': str(directory)})
    return directory


def current_artifact_path(output_dir: Path, file: Path) -> Path:
    """Resolve a legacy change record without changing its historical snapshots."""
    root = output_dir.absolute()
    directory = artifact_output_dir(root)
    if directory != root and file.is_relative_to(root):
        relative = file.relative_to(root)
        if relative.parts and (relative.parts[0] in _PUBLIC_DIRS or relative == Path('script.py')):
            return directory / relative
    return file
