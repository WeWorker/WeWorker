import fs from 'node:fs';
import path from 'node:path';
import { assertManagedFile } from '../adapter-package-files.js';
import { isPackageDraft, packageDraftBundle, readGenerationEvidence } from './package-inspection.js';

export function createDraftEvidenceTools(getAdapterDir, onWrite = () => {}) {
  return [{
    name: 'inspect_generation_evidence',
    description: '读取 v2 草稿的结构化来源证据与独立 mock 用例；来源证据不可修改。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const dir = getAdapterDir();
      if (!isPackageDraft(dir)) throw new Error('Historical drafts use inline verification fixtures.');
      return { source: readGenerationEvidence(dir), writeVerification: readGenerationEvidence(dir, 'write-verification.json', { optional: true }) };
    },
  }, {
    name: 'update_generated_command',
    description: '仅更新本轮新增 v2 命令的 schema、说明或 JavaScript 实现；保留旧命令和其他 manifest 元数据，不需要重写整个 manifest。',
    parameters: { type: 'object', properties: { commandId: { type: 'string' }, schema: { type: 'object', additionalProperties: true }, description: { type: 'string' }, source: { type: 'string' } }, required: ['commandId'], additionalProperties: false },
    execute: async ({ commandId, schema, description, source }) => {
      const dir = getAdapterDir();
      const { manifest } = packageDraftBundle(dir);
      const evidence = readGenerationEvidence(dir);
      const command = manifest.commands.find(item => item.id === commandId);
      if (!command || !Object.hasOwn(evidence.commands || {}, commandId)) throw new Error('Only commands generated in this run may be updated.');
      if (schema === undefined && description === undefined && source === undefined) throw new Error('A command update is required.');
      if (schema !== undefined && (!schema || typeof schema !== 'object' || Array.isArray(schema))) throw new Error('Command schema must be an object.');
      if (source !== undefined && (typeof source !== 'string' || !source.trim() || source.length > 50_000)) throw new Error('Command source must contain at most 50000 characters.');
      if (description !== undefined && (typeof description !== 'string' || !description.trim())) throw new Error('Command description is required.');
      if (schema !== undefined) command.schema = schema;
      if (description !== undefined) command.description = description;
      const content = JSON.stringify(manifest, null, 2) + '\n';
      if (content.length > 500_000) throw new Error('Command manifest exceeds size limit.');
      onWrite(commandId, 'command');
      if (source !== undefined) fs.writeFileSync(assertManagedFile(dir, command.module), source, 'utf8');
      fs.writeFileSync(assertManagedFile(dir, 'manifest.json'), content, 'utf8');
      return { written: true, commandId, command };
    },
  }, {
    name: 'write_generation_fixture',
    description: '保存 v2 草稿某个写命令的本地 mock 用例；独立于可安装包，只使用虚构参数。',
    parameters: { type: 'object', properties: { commandId: { type: 'string' }, fixture: { type: 'object', additionalProperties: true } }, required: ['commandId', 'fixture'], additionalProperties: false },
    execute: async ({ commandId, fixture }) => {
      const dir = getAdapterDir();
      const { manifest } = packageDraftBundle(dir);
      if (!manifest.commands.some(command => command.id === commandId && command.safety === 'write')) throw new Error('Fixture requires a declared write command.');
      if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) throw new Error('Fixture must be an object.');
      const data = readGenerationEvidence(dir, 'write-verification.json', { optional: true }) || { format: 2, commands: {} };
      data.commands[commandId] = fixture;
      const content = JSON.stringify(data, null, 2) + '\n';
      if (content.length > 50_000) throw new Error('Generation fixtures exceed size limit.');
      const file = assertManagedFile(path.dirname(dir), `.generation/${manifest.name}/write-verification.json`);
      fs.writeFileSync(file, content);
      onWrite(commandId, 'fixture');
      return { written: true, commandId };
    },
  }];
}
