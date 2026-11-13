from pathlib import Path
import json
import pytest

from webwright.server.file_changes import FileChangeJournal
from test_exploration_record_actions import setup_records


def test_records_text_binary_deletion_and_noop_with_persistent_snapshots(tmp_path):
    root = tmp_path / 'exp_example'
    root.mkdir()
    text = root / 'report.txt'
    text.write_text('before\n', encoding='utf-8', newline='')
    journal = FileChangeJournal(root)
    record = journal.begin('run_one', 1)
    text.write_text('after\n', encoding='utf-8', newline='')
    (root / 'plot.png').write_bytes(b'\x89PNG\x00data')
    (root / 'trajectory.json').write_text('{}')
    journal.finish(record)
    saved = FileChangeJournal(root).list()
    assert len(saved) == 1
    assert {f['operation'] for f in saved[0]['files']} == {'create', 'edit'}
    assert len(saved[0]['files']) == 2
    detail = journal.detail(record['id'], next(i for i, f in enumerate(saved[0]['files']) if f['path'].endswith('report.txt')))
    assert detail['file']['before']['text'] == 'before\n'
    assert detail['diff']['added'] == 1
    assert detail['diff']['removed'] == 1
    assert journal.finish(journal.begin('run_one', 2)) is None
    removal = journal.begin('run_one', 3)
    text.unlink()
    journal.finish(removal, failed=True)
    assert journal.list()[-1]['status'] == 'failed'
    assert journal.list()[-1]['files'][0]['operation'] == 'delete'


def test_routes_share_chat_contract_and_isolate_records(tmp_path):
    store, _, client = setup_records(tmp_path)
    journal = FileChangeJournal(store.task_dir('exp_example'))
    record = journal.begin('run_one', 1)
    (journal.root / 'report.txt').write_text('hello', encoding='utf-8')
    journal.finish(record)
    base = '/api/explorations/exp_example/file-changes'
    assert client.get(base).get_json()['records'][0]['id'] == record['id']
    assert client.get(base + '/' + record['id'] + '?file=0').get_json()['file']['after']['text'] == 'hello'
    assert client.get(base + '/' + record['id'] + '/artifact?file=0').data == b'hello'
    assert client.get(base + '/' + record['id'] + '?file=-1').status_code == 400
    assert client.get('/api/explorations/exp_other/file-changes/' + record['id']).status_code == 404
    assert client.get(base + '/invalid').status_code == 400
    assert client.post(base).status_code == 405
    client.delete('/api/explorations/exp_example')
    assert client.get(base).status_code == 404


def test_agent_records_partial_changes_on_action_failure(tmp_path):
    from webwright.agents.default import DefaultAgent
    from test_agent_control import ControlModel, ControlEnv
    model, env = ControlModel(), ControlEnv()
    def execute(action):
        (tmp_path / 'partial.txt').write_text('partial', encoding='utf-8')
        raise RuntimeError('example failure')
    env.execute = execute
    agent = DefaultAgent(model, env, system_template='System', instance_template='Task', output_path=tmp_path / 'trajectory.json')
    with pytest.raises(RuntimeError, match='example failure'):
        agent.execute_actions(model.query([]))
    records = FileChangeJournal(tmp_path).list()
    assert len(records) == 1
    assert records[0]['status'] == 'failed'
    assert records[0]['files'][0]['operation'] == 'create'


def test_links_are_not_read_and_interruption_never_fabricates_changes(tmp_path):
    root = tmp_path / 'exp'
    root.mkdir()
    outside = tmp_path / 'outside.txt'
    outside.write_text('private', encoding='utf-8')
    try:
        (root / 'link.txt').symlink_to(outside)
    except OSError:
        pytest.skip('Symlinks unavailable')
    journal = FileChangeJournal(root)
    pending = journal.begin('run_one', 1)
    assert journal.list()[0]['files'] == []
    assert journal.finish(pending) is None
    assert journal.list() == []
    with pytest.raises(ValueError):
        journal.detail('../outside', 0)


def test_large_artifacts_keep_metadata_and_agent_can_read_comparison_without_undo(tmp_path):
    from webwright.agents.default import DefaultAgent
    from test_agent_control import ControlModel, ControlEnv
    model, env = ControlModel(), ControlEnv()
    original = env.execute
    def execute(action):
        (tmp_path / 'large.pdf').write_bytes(b'\0' * (512 * 1024 + 1))
        (tmp_path / 'report.txt').write_text('Report', encoding='utf-8')
        return original(action)
    env.execute = execute
    agent = DefaultAgent(model, env, system_template='System', instance_template='Task', output_path=tmp_path / 'trajectory.json')
    agent.execute_actions(model.query([]))
    journal = FileChangeJournal(tmp_path)
    record = journal.list()[0]
    large = next(file for file in record['files'] if file['path'].endswith('large.pdf'))
    assert large['state'] == 'too_large'
    assert large['comparable'] is False
    assert large['size'] == 512 * 1024 + 1
    assert record['id'] in agent.messages[-1]['content']
    assert '先读取记录和当前文件' in agent.messages[-1]['content']


def test_snapshot_failure_cannot_cancel_the_action(tmp_path, monkeypatch):
    from webwright.agents.default import DefaultAgent
    from test_agent_control import ControlModel, ControlEnv
    model, env = ControlModel(), ControlEnv()
    monkeypatch.setattr(FileChangeJournal, 'begin', lambda *args: (_ for _ in ()).throw(OSError('example error')))
    agent = DefaultAgent(model, env, system_template='System', instance_template='Task', output_path=tmp_path / 'trajectory.json')
    agent.execute_actions(model.query([]))
    assert agent.messages[-1]['content'] == 'Observation: ok'
