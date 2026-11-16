import io
import json
import sys
from types import SimpleNamespace

import pytest

from webwright.shared_node import configure_shared_node
from webwright.run import bootstrap


def layout(tmp_path, **overrides):
    runtime = tmp_path / 'resources' / 'webwright'
    runtime.mkdir(parents=True)
    manifest = {'mode': 'embedded', 'platform': 'win32', 'arch': 'x64', 'node_runtime': 'shared', **overrides}
    (runtime / 'webwright-runtime.json').write_text(json.dumps(manifest), encoding='utf-8')
    node = runtime.parent / 'node-runtime' / 'node.exe'
    node.parent.mkdir(); node.write_bytes(b'fixture runtime')
    return runtime / 'Webwright.exe', node


def test_final_windows_runtime_overrides_inherited_node_selection(tmp_path):
    executable, node = layout(tmp_path)
    environment = {'PLAYWRIGHT_NODEJS_PATH': 'untrusted-node', 'KEEP': 'value'}
    assert configure_shared_node(executable=executable, frozen=True, platform='win32', environ=environment) == node
    assert environment == {'PLAYWRIGHT_NODEJS_PATH': str(node), 'KEEP': 'value'}


def test_missing_shared_node_never_falls_back_to_environment_or_component(tmp_path):
    executable, node = layout(tmp_path)
    node.unlink()
    component = executable.parent / '_internal/playwright/driver/node.exe'
    component.parent.mkdir(parents=True); component.write_bytes(b'old runtime')
    with pytest.raises(RuntimeError, match='reinstall'):
        configure_shared_node(executable=executable, frozen=True, platform='win32', environ={'PLAYWRIGHT_NODEJS_PATH': str(component)})


@pytest.mark.parametrize('overrides', [{'node_runtime': 'unknown'}, {'mode': 'standalone'}, {'arch': 'arm64'}, {'platform': 'darwin'}])
def test_invalid_shared_runtime_contract_is_rejected(tmp_path, overrides):
    executable, _ = layout(tmp_path, **overrides)
    with pytest.raises(RuntimeError, match='configuration'):
        configure_shared_node(executable=executable, frozen=True, platform='win32', environ={})


@pytest.mark.parametrize('frozen,platform', [(False, 'win32'), (True, 'darwin')])
def test_source_and_macos_keep_their_runtime_selection(tmp_path, frozen, platform):
    executable, _ = layout(tmp_path)
    environment = {'PLAYWRIGHT_NODEJS_PATH': 'original'}
    assert configure_shared_node(executable=executable, frozen=frozen, platform=platform, environ=environment) is None
    assert environment['PLAYWRIGHT_NODEJS_PATH'] == 'original'


def test_raw_onedir_and_standalone_keep_playwright_node(tmp_path):
    executable, _ = layout(tmp_path)
    manifest = executable.parent / 'webwright-runtime.json'
    manifest.write_text(json.dumps({'mode': 'embedded', 'platform': 'win32', 'arch': 'x64'}))
    environment = {}
    assert configure_shared_node(executable=executable, frozen=True, platform='win32', environ=environment) is None
    manifest.unlink()
    assert configure_shared_node(executable=executable, frozen=True, platform='win32', environ=environment) is None
    assert environment == {}


@pytest.mark.parametrize('arguments,entry', [(['--internal-script', 'fixture.py'], 'script'), (['--internal-worker', 'tool-debug'], 'worker'), ([], 'server')])
def test_every_frozen_entry_configures_node_before_dispatch(monkeypatch, arguments, entry):
    calls = []
    monkeypatch.setattr(bootstrap, '_configure_utf8_standard_streams', lambda: calls.append('utf8'))
    monkeypatch.setattr(bootstrap.multiprocessing, 'freeze_support', lambda: None)
    monkeypatch.setattr(bootstrap, 'configure_shared_node', lambda: calls.append('configure'))
    monkeypatch.setattr(bootstrap, '_run_internal_script', lambda args: calls.append('script') or 0)
    monkeypatch.setattr(bootstrap, '_run_internal_worker', lambda args: calls.append('worker') or 0)
    monkeypatch.setitem(sys.modules, 'webwright.run.server', SimpleNamespace(app=lambda: calls.append('server')))
    monkeypatch.setattr(sys, 'argv', ['Webwright.exe', *arguments])
    if arguments:
        with pytest.raises(SystemExit) as stopped:
            bootstrap.main()
        assert stopped.value.code == 0
    else:
        bootstrap.main()
    assert calls == ['utf8', 'configure', entry]


def test_frozen_entry_reconfigures_gbk_streams_to_utf8():
    stdin = io.TextIOWrapper(io.BytesIO(), encoding='gbk')
    stdout_buffer = io.BytesIO()
    stdout = io.TextIOWrapper(stdout_buffer, encoding='gbk')
    stderr = io.TextIOWrapper(io.BytesIO(), encoding='gbk')

    bootstrap._configure_utf8_standard_streams((
        (stdin, 'strict'),
        (stdout, 'backslashreplace'),
        (stderr, 'backslashreplace'),
    ))
    stdout.write(json.dumps({'text': '中文�🙂'}, ensure_ascii=False))
    stdout.flush()

    assert stdin.encoding == 'utf-8'
    assert stdout.encoding == 'utf-8'
    assert stderr.encoding == 'utf-8'
    assert stdout_buffer.getvalue().decode('utf-8') == '{"text": "中文�🙂"}'
