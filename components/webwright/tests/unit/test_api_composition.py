import base64
import json

import pytest

from webwright.server.adapter_v2 import compose_api_package, current_package, package_digest
from webwright.server.package_workspace import read_state
from webwright.server.toolkit_store import ToolkitStore


def workspace(tmp_path):
    store = ToolkitStore(tmp_path)
    store.create_toolkit(name='demo', allowed_domains=['example.com'])
    store.create_tool('demo', name='read_title', goal='Read title', start_url='https://example.com/')
    store.write_development_slot('demo', 'read_title', {
        'code': 'async def read_title(ctx):\n    return {"title": await ctx.page.title()}',
        'description': 'Read title', 'risk_notice': '', 'safety': 'read',
        'parameters_schema': {'type': 'object', 'properties': {}},
        'result_schema': {'type': 'object', 'properties': {'title': {'type': 'string'}}},
    })
    return store


def api_package(command_id='list-items'):
    manifest = {'schema_version': 2, 'name': 'example.com', 'version': '1.0.0', 'description': 'Example', 'match': ['example.com'],
                'commands': [{'id': command_id, 'runtime': 'extension', 'module': f'extension/commands/{command_id}.js',
                              'description': 'List items', 'schema': {'type': 'object', 'properties': {}}, 'safety': 'read'}]}
    files = {'manifest.json': json.dumps(manifest).encode(), f'extension/commands/{command_id}.js': b'window.__webcliRegisterCommand("list-items", async () => ({items: []}));'}
    return {'files': {name: base64.b64encode(value).decode() for name, value in files.items()},
            'digest': package_digest(files), 'profile': 'public', 'baselineDigest': None}


def test_compose_one_package_preserves_api_bytes_and_toolkit_slots(tmp_path):
    store = workspace(tmp_path)
    before = read_state(store, 'demo')
    api = api_package()
    result = compose_api_package(store, 'demo', expected_digest=before['candidate_digest'], package=api, source={'task_id': 'task-placeholder', 'profile': 'profile-placeholder'})
    metadata, files, _ = current_package(store, 'demo')
    manifest = json.loads(files['manifest.json'])
    assert metadata['name'] == 'example.com'
    assert result['digest'] == metadata['digest'] != api['digest']
    assert {command['runtime'] for command in manifest['commands']} == {'extension', 'wewright'}
    assert files['extension/commands/list-items.js'] == base64.b64decode(api['files']['extension/commands/list-items.js'])
    assert store.read_development_slot('demo', 'read_title')['code'].startswith('async def read_title')
    assert read_state(store, 'demo')['last_applied_digest'] is None
    # Editing Toolkit retains the frozen API snapshot and creates a new digest.
    slot = store.read_development_slot('demo', 'read_title')
    store.write_development_slot('demo', 'read_title', {**slot, 'description': 'Read current title'})
    newer, files, _ = current_package(store, 'demo')
    assert newer['digest'] != metadata['digest']
    assert files['extension/commands/list-items.js'] == base64.b64decode(api['files']['extension/commands/list-items.js'])


@pytest.mark.parametrize('failure', ['stale', 'conflict', 'baseline', 'digest', 'scope'])
def test_rejected_composition_does_not_advance_workspace(tmp_path, failure):
    store = workspace(tmp_path)
    before = read_state(store, 'demo')
    api = api_package('read-title' if failure == 'conflict' else 'list-items')
    expected = before['candidate_digest']
    if failure == 'stale':
        expected = '0' * 64
    if failure == 'baseline':
        api['baselineDigest'] = '0' * 64
    if failure == 'digest':
        api['digest'] = '0' * 64
    if failure == 'scope':
        manifest = json.loads(base64.b64decode(api['files']['manifest.json']))
        manifest['match'] = ['example.org']
        files = {name: base64.b64decode(value) for name, value in api['files'].items()}
        files['manifest.json'] = json.dumps(manifest).encode()
        api.update(digest=package_digest(files), files={name: base64.b64encode(value).decode() for name, value in files.items()})
    with pytest.raises(ValueError):
        compose_api_package(store, 'demo', expected_digest=expected, package=api, source={'task_id': 'task-placeholder'})
    assert read_state(store, 'demo') == before


def test_host_endpoint_requires_identity_and_reports_unverified_final_toolkit(tmp_path, monkeypatch):
    from webwright.server.app import create_app
    from webwright.paths import WebwrightPaths
    monkeypatch.setenv('WEWORKER_EXPLORATION_INSTANCE_ID', 'instance-placeholder')
    store = workspace(tmp_path / 'toolkits')
    app = create_app(paths=WebwrightPaths.resolve(home=tmp_path / 'service'), toolkit_store=store,
                     weworker_user_files_dir=tmp_path / 'user')
    client = app.test_client()
    args = {'expected_digest': read_state(store, 'demo')['candidate_digest'], 'package': api_package(),
            'source': {'task_id': 'task-placeholder', 'profile': 'browser-placeholder'}}
    assert client.post('/api/toolkits/demo/compose-api', json=args).status_code == 403
    response = client.post('/api/toolkits/demo/compose-api', json=args, headers={'X-WeWorker-Exploration-Instance': 'instance-placeholder'})
    assert response.status_code == 200, response.get_json()
    result = client.get('/api/toolkits/demo/v2-package')
    assert result.status_code == 200, result.get_json()
    payload = result.get_json()
    assert payload['composition_debug_verified'] is False
    assert payload['composition_tool_ids'] == ['read-title']
    assert payload['api_composition']['digest'] == args['package']['digest']
    listed = client.post('/api/development/commands/list', json={}, headers={'X-WeWorker-Exploration-Instance': 'instance-placeholder'}).get_json()
    assert listed['data']['workspaces'][0]['retained_commands'] == [{'id': 'list-items', 'runtime': 'extension'}]
