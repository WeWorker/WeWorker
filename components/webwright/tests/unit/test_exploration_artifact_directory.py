import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import yaml
import pytest

from webwright.environments.local_browser import LocalBrowserEnvironment
from webwright.server.file_changes import FileChangeJournal
from webwright.server.artifacts import read_script, read_steps, resolve_task_file


def test_artifact_directory_is_host_owned_and_used_by_real_actions(tmp_path, monkeypatch):
    env = LocalBrowserEnvironment(output_dir=tmp_path / 'exploration')
    monkeypatch.setattr(env, '_prepare_async', AsyncMock())
    env.prepare(task='Read example.com', artifact_dir=str(tmp_path / 'untrusted'))
    expected = env.config.output_dir.resolve() / 'artifacts'
    assert env._prepared_task['artifact_dir'] == str(expected)
    assert env.get_template_vars()['artifact_dir'] == str(expected)
    assert expected.is_dir()
    # Run the actual Python action wrapper. No browser navigation or model service.
    env._page = env._context = env._browser = env._playwright = object()
    asyncio.run(env._run_python_code("from pathlib import Path\nPath(task['artifact_dir'], 'report.md').write_text('Report', encoding='utf-8')"))
    assert (expected / 'report.md').read_text(encoding='utf-8') == 'Report'
    assert not (tmp_path / 'untrusted').exists()


def test_both_live_browser_prompts_allow_only_task_artifacts():
    config = Path(__file__).parents[2] / 'src/webwright/config/local_browser.yaml'
    data = yaml.safe_load(config.read_text(encoding='utf-8'))
    for key in ['system_template', 'instance_template']:
        prompt = data['agent'][key]
        assert "task['artifact_dir']" in prompt
        assert 'Do NOT write artifact files' not in prompt
        assert 'Do NOT write any files' not in prompt
        assert 'outside' in prompt


def prepare_managed(tmp_path, monkeypatch, task_id='exp_example'):
    user_files = tmp_path / 'configured-user-files'
    monkeypatch.setenv('WEWORKER_USER_FILES_DIR', str(user_files))
    internal = tmp_path / 'service-data' / 'tasks' / task_id
    env = LocalBrowserEnvironment(output_dir=internal)
    monkeypatch.setattr(env, '_prepare_async', AsyncMock())
    env.prepare(task='Read example.com', task_id=task_id)
    return env, internal, user_files / 'website-exploration' / task_id


def test_managed_outputs_are_written_directly_to_visible_workspace(tmp_path, monkeypatch):
    env, internal, visible = prepare_managed(tmp_path, monkeypatch)
    assert Path(env._prepared_task['artifact_dir']) == visible / 'artifacts'
    assert env._screenshots_dir() == visible / 'screenshots'
    assert env._steps_dir() == visible / 'steps'
    env._step_index = 1
    env._persist_step_code('print(page.url)')
    assert (visible / 'script.py').is_file()
    assert (internal / 'task.json').is_file()
    assert not (internal / 'script.py').exists()
    assert not (visible / 'task.json').exists()


def test_workspace_changes_preview_and_timeline_use_same_real_files(tmp_path, monkeypatch):
    env, internal, visible = prepare_managed(tmp_path, monkeypatch)
    journal = FileChangeJournal(internal)
    first = journal.begin('run_one', 1)
    report = visible / 'artifacts' / 'report.md'
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text('Before', encoding='utf-8')
    env._step_index = 1
    env._persist_step_code('print(page.url)')
    env._screenshots_dir().mkdir(parents=True, exist_ok=True)
    (env._screenshots_dir() / 'step_0001.png').write_bytes(b'\x89PNG\0example')
    journal.finish(first)
    files = journal.list()[0]['files']
    assert any(Path(file['path']) == report for file in files)
    assert all(Path(file['path']).is_relative_to(visible) for file in files)
    second = journal.begin('run_one', 2)
    report.write_text('After', encoding='utf-8')
    journal.finish(second)
    detail = journal.detail(second['id'])
    assert detail['file']['before']['text'] == 'Before'
    assert detail['file']['after']['text'] == 'After'
    assert journal.artifact(second['id']) == report
    assert resolve_task_file(internal, 'screenshots/step_0001.png') == env._screenshots_dir() / 'step_0001.png'
    assert read_steps('exp_example', internal)[0]['code'] == 'print(page.url)'
    assert 'print(page.url)' in read_script(internal)
    assert (internal / '.server' / 'file-changes').is_dir()
    assert not (visible / '.server').exists()


def test_workspace_resume_preserves_files_and_isolates_other_tasks(tmp_path, monkeypatch):
    env, internal, visible = prepare_managed(tmp_path, monkeypatch)
    report = Path(env._prepared_task['artifact_dir']) / 'report.md'
    report.write_text('Keep existing report', encoding='utf-8')
    resumed, _, same = prepare_managed(tmp_path, monkeypatch)
    assert same == visible
    assert Path(resumed._prepared_task['artifact_dir'], 'report.md').read_text() == 'Keep existing report'
    other, _, other_visible = prepare_managed(tmp_path, monkeypatch, 'exp_other')
    assert other_visible != visible
    assert not Path(other._prepared_task['artifact_dir'], 'report.md').exists()


def test_managed_workspace_rejects_link_redirection(tmp_path, monkeypatch):
    user_files = tmp_path / 'configured-user-files'
    user_files.mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    try:
        (user_files / 'website-exploration').symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip('Symlinks unavailable')
    monkeypatch.setenv('WEWORKER_USER_FILES_DIR', str(user_files))
    env = LocalBrowserEnvironment(output_dir=tmp_path / 'tasks' / 'exp_example')
    monkeypatch.setattr(env, '_prepare_async', AsyncMock())
    with pytest.raises(ValueError):
        env.prepare(task='Read example.com')
    assert not list(outside.iterdir())


def test_resuming_legacy_outputs_preserves_history_and_makes_files_visible(tmp_path, monkeypatch):
    from webwright.server.artifact_workspace import artifact_output_dir
    internal = tmp_path / 'tasks' / 'exp_legacy'
    report = internal / 'artifacts' / 'report.md'
    report.parent.mkdir(parents=True)
    journal = FileChangeJournal(internal)
    record = journal.begin('run_one', 1)
    report.write_text('Original report', encoding='utf-8')
    (internal / 'script.py').write_text('print(page.url)', encoding='utf-8')
    (internal / 'trajectory.json').write_text('{"messages":[]}', encoding='utf-8')
    journal.finish(record)
    user_files = tmp_path / 'configured-user-files'
    monkeypatch.setenv('WEWORKER_USER_FILES_DIR', str(user_files))
    env = LocalBrowserEnvironment(output_dir=internal, resume_existing_output=True)
    monkeypatch.setattr(env, '_prepare_async', AsyncMock())
    env.prepare(task='Continue the example')
    visible = user_files / 'website-exploration' / internal.name
    copied = visible / 'artifacts' / 'report.md'
    assert copied.read_text() == report.read_text() == 'Original report'
    assert not (visible / 'trajectory.json').exists()
    saved = journal.list()[0]
    index = next(i for i, f in enumerate(saved['files']) if f['path'].endswith('report.md'))
    assert Path(saved['files'][index]['path']) == copied
    assert journal.detail(record['id'], index)['file']['after']['text'] == 'Original report'
    assert journal.artifact(record['id'], index) == copied
    copied.write_text('Edited in workspace', encoding='utf-8')
    env.prepare(task='Continue again')
    assert copied.read_text() == 'Edited in workspace'
    # An existing task keeps its assigned location after settings change.
    monkeypatch.setenv('WEWORKER_USER_FILES_DIR', str(tmp_path / 'another-root'))
    assert artifact_output_dir(internal) == visible


def test_managed_artifact_routes_use_workspace_and_reject_other_files(tmp_path, monkeypatch):
    from test_exploration_record_actions import setup_records
    store, _, client = setup_records(tmp_path)
    monkeypatch.setenv('WEWORKER_USER_FILES_DIR', str(tmp_path / 'configured-user-files'))
    env = LocalBrowserEnvironment(output_dir=store.task_dir('exp_example'))
    monkeypatch.setattr(env, '_prepare_async', AsyncMock())
    env.prepare(task='Read example.com')
    journal = FileChangeJournal(store.task_dir('exp_example'))
    record = journal.begin('run_one', 1)
    report = Path(env._prepared_task['artifact_dir']) / 'report.txt'
    report.write_text('Visible file', encoding='utf-8')
    journal.finish(record)
    base = '/api/explorations/exp_example/file-changes/' + record['id']
    assert client.get(base + '/artifact?file=0').data == b'Visible file'
    assert Path(client.get(base).get_json()['file']['path']) == report
    assert client.get('/api/explorations/exp_example/files/artifacts/report.txt').data == b'Visible file'
    assert client.get('/api/explorations/exp_other/file-changes/' + record['id']).status_code == 404
    with pytest.raises(ValueError):
        resolve_task_file(journal.root, '../exp_other/artifacts/report.txt')


def test_saved_model_history_uses_current_assigned_artifact_directory(tmp_path, monkeypatch):
    from test_agent_control import ControlModel
    from webwright.agents.default import DefaultAgent
    env, internal, visible = prepare_managed(tmp_path, monkeypatch)
    agent = DefaultAgent(ControlModel(), env, system_template='System', instance_template='Task', output_path=internal / 'trajectory.json')
    agent.messages = [{'role': 'system', 'content': 'Historical no-file-writing instruction'}]
    message = agent._messages_for_model()[0]['content']
    assert str(visible / 'artifacts') in message
    assert 'replaces any obsolete directory' in message
    assert agent.messages[0]['content'] == 'Historical no-file-writing instruction'
