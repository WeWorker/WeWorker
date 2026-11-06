from __future__ import annotations

import json
import pytest

from webwright.paths import WebwrightPaths
from webwright.server.app import create_app
from webwright.server.package_workspace import read_state
from webwright.server.process_manager import BusyError


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("WEWORKER_EXPLORATION_INSTANCE_ID", "test-instance-placeholder")
    app = create_app(paths=WebwrightPaths.resolve(home=tmp_path))
    client = app.test_client()
    headers = {"X-WeWorker-Exploration-Instance": "test-instance-placeholder"}
    def call(command, args):
        response = client.post(f"/api/development/commands/{command}", json=args, headers=headers)
        return response.status_code, response.get_json()
    return app, client, call


def create(call):
    status, response = call("create", {"toolkit_id": "demo", "tool_id": "read_title", "allowed_domains": ["example.com"],
                                       "goal": "Read title", "start_url": "https://example.com/"})
    assert status == 200, response
    return response["data"]


def submission(revision=0, **changes):
    return {"toolkit_id": "demo", "tool_id": "read_title", "expected_revision": revision,
            "code": 'async def read_title(ctx):\n    return {"title": await ctx.page.title()}',
            "description": "Read title", "risk_notice": "", "safety": "read",
            "parameters_schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
            "result_schema": {"type": "object", "properties": {"title": {"type": "string"}}}, **changes}


def test_save_build_exact_package_without_install(api):
    app, client, call = api
    assert client.get('/api/health').get_json()['capabilities']['development_commands'] is True
    create(call)
    status, saved = call("save", submission())
    assert status == 200, saved
    assert saved["data"]["revision"] == 1
    assert saved["data"]["formal"] is None
    slot = saved["data"]["development"]
    assert isinstance(slot["parameters_schema"], dict)
    status, built = call("build", {"toolkit_id": "demo", "expected_revision": 1})
    assert status == 200, built
    data = built["data"]
    assert data["digest"] == saved["data"]["candidate_digest"]
    assert data["manifest"]["schema_version"] == 2
    assert data["manifest"]["commands"][0]["safety"] == "read"
    assert not data["installed"] and not data["runtime_verified"]
    store = app.config["WEBWRIGHT_TOOLKIT_STORE"]
    state = read_state(store, "demo")
    assert state["last_applied_digest"] is None
    # Metadata-only changes also participate in the concurrency revision.
    status, updated = call("save", submission(1, description="Updated description"))
    assert status == 200
    assert updated["data"]["revision"] == 2
    assert updated["data"]["development"]["code_hash"] == slot["code_hash"]
    assert call("save", submission(1))[1]["error"]["code"] == "STALE_REVISION"
    assert call("build", {"toolkit_id": "demo", "expected_revision": 1})[1]["error"]["code"] == "STALE_REVISION"


@pytest.mark.parametrize("changes", [
    {"parameters_schema": '{"type":"object"}'}, {"result_schema": '{}'},
    {"code": "def read_title(ctx):\n    return {}"},
    {"code": "async def read_title(ctx, value):\n    return {}"},
    {"code": "async def read_title(ctx, cdp_url):\n    return {}"},
    {"description": {}}, {"safety": "unsafe"}, {"expected_revision": True},
    {"source_exploration_id": "untrusted"},
])
def test_invalid_save_does_not_advance_workspace(api, changes):
    app, _, call = api
    create(call)
    before = read_state(app.config["WEBWRIGHT_TOOLKIT_STORE"], "demo")
    status, result = call("save", submission(**changes))
    assert status == 400, result
    assert not result["ok"]
    assert read_state(app.config["WEBWRIGHT_TOOLKIT_STORE"], "demo") == before


def test_validate_has_no_writes_and_requires_object_schemas(api):
    app, _, call = api
    args = submission()
    for key in ("toolkit_id", "expected_revision"):
        args.pop(key)
    assert call("validate", args)[0] == 200
    assert app.config["WEBWRIGHT_TOOLKIT_STORE"].list_toolkits() == []
    assert call("validate", {**args, "result_schema": "{}"})[0] == 400


def test_identity_unknown_command_and_origin_boundary(api):
    _, client, call = api
    assert client.post('/api/development/commands/create', json={}).status_code == 403
    assert call("unknown", {})[1]["error"]["code"] == "UNKNOWN_COMMAND"
    assert client.post('/api/development/commands/create', json={}, headers={
        "Origin": "https://example.com", "X-WeWorker-Exploration-Instance": "test-instance-placeholder"}).status_code == 403


def test_create_never_overwrites_or_widens_grants(api):
    app, _, call = api
    create(call)
    assert call("create", {"toolkit_id": "demo", "tool_id": "read_title", "allowed_domains": ["example.com"],
                           "goal": "Changed", "start_url": "https://example.com/"})[1]["error"]["code"] == "TOOL_EXISTS"
    assert call("create", {"toolkit_id": "demo", "tool_id": "other", "allowed_domains": ["example.org"],
                           "goal": "Other", "start_url": "https://example.org/"})[0] == 400
    assert app.config["WEBWRIGHT_TOOLKIT_STORE"].get_toolkit("demo")["allowed_domains"] == ["example.com"]


def test_busy_save_is_rejected(api, monkeypatch):
    app, _, call = api
    create(call)
    def busy():
        raise BusyError("Busy")
    monkeypatch.setattr(app.config["WEBWRIGHT_PROCESS_MANAGER"], "_ensure_not_busy_locked", busy)
    assert call("save", submission())[1]["error"]["code"] == "BUSY"


def test_debug_uses_exact_package_cli_channel_and_requires_confirmation(api, monkeypatch):
    app, _, call = api
    create(call)
    status, saved = call("save", submission(safety="write", risk_notice="May submit changes"))
    assert status == 200
    data = saved["data"]
    built = call("build", {"toolkit_id": "demo", "expected_revision": 1})[1]["data"]
    assert built["manifest"]["commands"][0]["safety"] == "write"
    received = []
    def start(**kwargs):
        received.append(kwargs)
        return {"debug_run_id": "debug_placeholder", "status": "running"}
    monkeypatch.setattr(app.config["WEBWRIGHT_PROCESS_MANAGER"], "start_debug_run", start)
    args = {"toolkit_id": "demo", "tool_id": "read_title", "expected_revision": 1,
            "expected_digest": data["candidate_digest"], "parameters": {}, "confirmed": False}
    assert call("debug", args)[1]["error"]["code"] == "CONFIRMATION_REQUIRED"
    assert call("debug", {**args, "confirmed": True, "expected_digest": "changed"})[1]["error"]["code"] == "STALE_PACKAGE"
    assert received == []
    assert call("debug", {**args, "confirmed": True})[0] == 200
    assert received[0]["channel"] == "formal"
    assert received[0]["expected_distribution_hash"] == data["candidate_digest"]
    assert received[0]["parameters"] == {"__confirmed": True}


def test_tampered_package_cannot_build(api):
    from pathlib import Path
    _, _, call = api
    create(call)
    call("save", submission())
    built = call("build", {"toolkit_id": "demo", "expected_revision": 1})[1]["data"]
    (Path(built["package_path"]) / 'manifest.json').write_text('{}')
    assert call("build", {"toolkit_id": "demo", "expected_revision": 1})[0] == 400

def test_saved_package_passes_host_v2_reader(api):
    import shutil
    import subprocess
    from pathlib import Path
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for cross-runtime package verification")
    _, _, call = api
    create(call)
    call("save", submission())
    built = call("build", {"toolkit_id": "demo", "expected_revision": 1})[1]["data"]
    repo = Path(__file__).resolve().parents[4]
    reader = (repo / 'webcli' / 'adapter-package-files.js').as_uri()
    code = f'import {{readPackageDirectory}} from {json.dumps(reader)}; console.log(JSON.stringify(readPackageDirectory(process.argv[1]).digest));'
    result = subprocess.run([node, '--input-type=module', '-e', code, built['package_path']], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == built['digest']


def test_real_debug_manager_builds_isolated_snapshot_without_applying(api, monkeypatch):
    from pathlib import Path
    from webwright.server import process_manager
    app, _, call = api
    create(call)
    saved = call('save', submission())[1]['data']
    manager = app.config['WEBWRIGHT_PROCESS_MANAGER']
    captured = []
    class Pending:
        pid = 9999
        def poll(self):
            return None
    class Thread:
        def __init__(self, **kwargs):
            pass
        def start(self):
            pass
    def spawn(command, log_path, **kwargs):
        captured.append(Path(log_path).parent)
        return Pending()
    monkeypatch.setattr(manager, '_spawn', spawn)
    monkeypatch.setattr(process_manager.threading, 'Thread', Thread)
    status, response = call('debug', {'toolkit_id': 'demo', 'tool_id': 'read_title',
        'expected_revision': 1, 'expected_digest': saved['candidate_digest'], 'parameters': {}, 'confirmed': True})
    assert status == 200, response
    spec = json.loads((captured[0] / 'debug_spec.json').read_text())
    assert spec['v2'] is True and spec['channel'] == 'formal'
    assert spec['distribution_hash'] == saved['candidate_digest']
    assert (Path(spec['adapter_root']) / 'manifest.json').is_file()
    catalog = json.loads((captured[0] / 'catalog' / '.profile.json').read_text())
    assert catalog['adapters'][0]['digest'] == saved['candidate_digest']
    assert read_state(app.config['WEBWRIGHT_TOOLKIT_STORE'], 'demo')['last_applied_digest'] is None
    run = call('debug-get', {'debug_run_id': response['data']['debug_run_id']})[1]['data']
    assert run['distribution_hash'] == saved['candidate_digest']
    assert call('debug-get', {'debug_run_id': []})[0] == 400

def test_invalid_json_has_structured_response(api):
    _, client, _ = api
    response = client.post('/api/development/commands/validate', data='{invalid', headers={
        'X-WeWorker-Exploration-Instance': 'test-instance-placeholder', 'Content-Type': 'application/json'})
    assert response.status_code == 400
    assert response.get_json()['error']['code'] == 'INVALID_ARGUMENT'


def test_busy_slot_cannot_lose_write_classification(api):
    app, _, call = api
    create(call)
    call('save', submission(safety='write'))
    store = app.config['WEBWRIGHT_TOOLKIT_STORE']
    replacement = submission()
    for key in ('toolkit_id', 'tool_id', 'expected_revision', 'safety'):
        replacement.pop(key)
    store.write_development_slot('demo', 'read_title', replacement)
    assert store.read_development_slot('demo', 'read_title')['safety'] == 'write'

@pytest.mark.parametrize("newer_draft", [False, True])
def test_host_ack_promotes_exact_cli_candidate_without_losing_newer_work(tmp_path, monkeypatch, newer_draft):
    monkeypatch.setenv("WEWORKER_EXPLORATION_INSTANCE_ID", "test-instance-placeholder")
    app = create_app(paths=WebwrightPaths.resolve(home=tmp_path), weworker_user_files_dir=tmp_path / "user-files")
    client = app.test_client()
    headers = {"X-WeWorker-Exploration-Instance": "test-instance-placeholder"}
    def call(command, args):
        response = client.post(f"/api/development/commands/{command}", json=args, headers=headers)
        return response.status_code, response.get_json()
    create(call)
    saved = call("save", submission())[1]["data"]
    prepared = client.get("/api/toolkits/demo/v2-package").get_json()
    assert prepared["digest"] == saved["candidate_digest"]
    if newer_draft:
        assert call("save", submission(1, description="Newer draft"))[0] == 200
    ack = client.post("/api/toolkits/demo/installation-ack", json={
        "digest": prepared["digest"], "revision": 1, "profile": "public", "operation_id": prepared["operation_id"]})
    assert ack.status_code == 200, ack.get_json()
    inspected = call("inspect", {"toolkit_id": "demo", "tool_id": "read_title"})[1]["data"]
    assert inspected["formal"]["description"] == "Read title"
    if newer_draft:
        assert inspected["development"]["description"] == "Newer draft"
    else:
        assert inspected["development"] is None
    assert read_state(app.config["WEBWRIGHT_TOOLKIT_STORE"], "demo")["last_applied_digest"] == prepared["digest"]

INPUT_ROUTE = '/api/explorations/exp_input/development/input'
INPUT_HEADERS = {'X-WeWorker-Exploration-Instance': 'test-instance-placeholder'}


def input_exploration(app, **changes):
    store = app.config['WEBWRIGHT_TASK_STORE']
    store.create_task_record(task_id='exp_input', title='Example', instruction='Read title',
                            start_url='https://example.com/', output_dir=store.task_dir('exp_input'),
                            run_id='run-placeholder', activity_type='exploration',
                            toolkit_id='', tool_id='')
    store.update_task('exp_input', status='succeeded', **changes)
    return 'exp_input'


def test_prepare_input_without_any_target_or_workspace(api, monkeypatch):
    app, client, call = api
    manager = app.config['WEBWRIGHT_PROCESS_MANAGER']
    monkeypatch.setattr(manager, 'start_development', lambda **kwargs: pytest.fail('must not launch a model'))
    assert client.post(INPUT_ROUTE, json={}).status_code == 403
    assert client.post(INPUT_ROUTE, json={}, headers=INPUT_HEADERS).status_code == 404
    input_exploration(app)
    response = client.post(INPUT_ROUTE, json={}, headers=INPUT_HEADERS)
    assert response.status_code == 200, response.get_json()
    result = response.get_json()
    assert result == {
        'schema_version': 1, 'instruction': 'Read title',
        'site': {'start_url': 'https://example.com/', 'allowed_domains': ['example.com']},
        'source_exploration': {'exploration_id': 'exp_input', 'run_id': 'run-placeholder', 'instruction': 'Read title', 'steps': [], 'messages': []},
    }
    assert call('list', {})[1]['data']['workspaces'] == []


@pytest.mark.parametrize('payload', [
    {'instruction': {}}, {'destination': 'input.json'}, {'toolkit_id': 'demo'}, {'source_exploration_id': 'other'},
    {'target': {}}, {'target': None}, {'target': {'tool_id': 'read'}},
    {'target': {'adapter_id': '../other'}}, {'target': {'adapter_id': 'example.com', 'tool_id': []}},
    {'target': {'adapter_id': 'example.com', 'extra': 'ignored'}},
])
def test_prepare_input_rejects_invalid_payload(api, payload):
    app, client, call = api
    input_exploration(app)
    assert client.post(INPUT_ROUTE, json=payload, headers=INPUT_HEADERS).status_code == 400


def test_input_provenance_is_not_a_destination_and_does_not_require_old_workspace(api):
    app, client, call = api
    input_exploration(app, toolkit_id='previous', tool_id='old_tool')
    target = {'adapter_id': 'example.com', 'tool_id': 'read-title'}
    response = client.post(INPUT_ROUTE, json={'target': target, 'instruction': 'Improve title'}, headers=INPUT_HEADERS)
    assert response.status_code == 200
    result = response.get_json()
    assert result['target'] == target
    assert result['instruction'] == 'Improve title'
    assert result['source_exploration']['provenance'] == {'toolkit_id': 'previous', 'tool_id': 'old_tool'}
    assert 'toolkit' not in result and 'tool' not in result and 'base_slot' not in result
    assert call('list', {})[1]['data']['workspaces'] == []


@pytest.mark.parametrize('status', ['running', 'failed'])
def test_prepare_input_rejects_unfinished_source(api, status):
    app, client, call = api
    input_exploration(app)
    app.config['WEBWRIGHT_TASK_STORE'].update_task('exp_input', status=status)
    assert client.post(INPUT_ROUTE, json={}, headers=INPUT_HEADERS).status_code == 400


@pytest.mark.parametrize('url', ['file:///tmp/example', 'https://user:placeholder@example.com/', 'not-a-url'])
def test_prepare_input_rejects_invalid_site(api, url):
    app, client, call = api
    input_exploration(app, start_url=url)
    assert client.post(INPUT_ROUTE, json={}, headers=INPUT_HEADERS).status_code == 400


def test_list_discovers_drafts_without_changing_revision_or_runtime(api):
    app, client, call = api
    create(call)
    call('save', submission())
    before = call('inspect', {'toolkit_id': 'demo', 'tool_id': 'read_title'})[1]
    status, listed = call('list', {})
    assert status == 200
    workspace = listed['data']['workspaces'][0]
    assert workspace['adapter_id'] == 'demo'
    assert workspace['toolkit_id'] == 'demo'
    assert workspace['revision'] == before['data']['revision']
    assert workspace['tools'][0]['command_id'] == 'read-title'
    assert workspace['tools'][0]['runtime'] == 'wewright'
    assert workspace['tools'][0]['has_development'] is True
    assert workspace['retained_commands'] == []
    assert call('inspect', {'toolkit_id': 'demo', 'tool_id': 'read_title'})[1] == before
    assert call('list', {'unknown': True})[0] == 400

def test_list_bound_adapter_retains_original_runtime_and_bytes_when_adding_tool(tmp_path, monkeypatch):
    import base64
    from webwright.server.adapter_v2 import package_digest
    monkeypatch.setenv("WEWORKER_EXPLORATION_INSTANCE_ID", "test-instance-placeholder")
    app = create_app(paths=WebwrightPaths.resolve(home=tmp_path), weworker_user_files_dir=tmp_path / "user-files")
    client = app.test_client()
    def call(command, args):
        response = client.post(f'/api/development/commands/{command}', json=args, headers=INPUT_HEADERS)
        return response.status_code, response.get_json()
    assert client.post('/api/toolkits', json={'name': 'bound', 'allowed_domains': ['example.com']}).status_code in (200, 201)
    files = {
        'manifest.json': json.dumps({'schema_version': 2, 'name': 'example.com', 'version': '1.0.0',
            'description': 'Example', 'match': ['example.com'], 'commands': [{
                'id': 'existing', 'runtime': 'extension', 'module': 'extension/commands/existing.js',
                'description': 'Existing', 'schema': {'type': 'object', 'properties': {}},
            }]}).encode(),
        'extension/commands/existing.js': b'const original = true;',
    }
    digest = package_digest(files)
    response = client.post('/api/toolkits/bound/bind-adapter', json={
        'profile': 'public', 'digest': digest,
        'files': {name: base64.b64encode(data).decode() for name, data in files.items()},
    })
    assert response.status_code == 200, response.get_json()
    workspace = call('list', {})[1]['data']['workspaces'][0]
    assert workspace['adapter_id'] == 'example.com'
    assert workspace['install_baseline_digest'] == digest
    assert workspace['retained_commands'] == [{'id': 'existing', 'runtime': 'extension'}]
    assert workspace['tools'] == []
    status, conflict = call('create', {'toolkit_id': 'bound', 'tool_id': 'existing', 'allowed_domains': ['example.com'],
                                       'goal': 'Do not replace', 'start_url': 'https://example.com/'})
    assert status == 400
    assert conflict['error']['code'] == 'RETAINED_COMMAND'
    assert call('list', {})[1]['data']['workspaces'][0]['tools'] == []
    assert call('create', {'toolkit_id': 'bound', 'tool_id': 'read_title', 'allowed_domains': ['example.com'],
                          'goal': 'Read title', 'start_url': 'https://example.com/'})[0] == 200
    revision = call('inspect', {'toolkit_id': 'bound', 'tool_id': 'read_title'})[1]['data']['revision']
    status, saved = call('save', submission(revision, toolkit_id='bound'))
    assert status == 200, saved
    package = client.get('/api/toolkits/bound/v2-package').get_json()
    assert package['files']['extension/commands/existing.js'] == base64.b64encode(files['extension/commands/existing.js']).decode()
    manifest = json.loads(base64.b64decode(package['files']['manifest.json']))
    assert [command['runtime'] for command in manifest['commands']] == ['extension', 'wewright']


def test_exploration_view_exposes_run_identity_not_unrelated_updates(api):
    app, client, _ = api
    input_exploration(app)
    store = app.config['WEBWRIGHT_TASK_STORE']
    route = '/api/explorations/exp_input'
    assert client.get(route).get_json()['last_run_id'] == 'run-placeholder'
    store.update_task('exp_input', title='Renamed example')
    assert client.get(route).get_json()['last_run_id'] == 'run-placeholder'
    store.update_task('exp_input', last_run_id='run-followup-placeholder', status='running')
    assert client.get(route).get_json()['last_run_id'] == 'run-followup-placeholder'
