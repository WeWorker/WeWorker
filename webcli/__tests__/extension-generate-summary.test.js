import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function readText(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function loadStoredMemoryBuilder() {
  const source = readText('extension/background/service-worker.js');
  const sections = [
    ['const REQUEST_TRUNCATION_MARKER_RE', 'function sanitizeActionCaptureResult('],
    ['function isTelemetryLikeEntry(', 'function looksJsonPayload('],
    ['function safeStoredText(', 'function normalizeExploreStateSiteKey('],
  ].map(([startMarker, endMarker]) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  });
  // Run the real storage builders without starting browser listeners or network I/O.
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(sections.join('\n'), context, { timeout: 1000 });
  return context.buildStoredSiteMemory;
}

describe('extension scaffold generation summary', () => {
  it('dedupes generated file paths in sidepanel and popup summaries', () => {
    const sidepanel = readText('extension/sidepanel/sidepanel.js');
    const popup = readText('extension/popup/popup.js');

    expect(sidepanel).toContain('function collectUniqueGeneratedFileLines');
    expect(sidepanel).toContain('collectUniqueGeneratedFileLines(r.files)');
    expect(sidepanel).not.toContain('Object.values(r.files || {}).filter');

    expect(popup).toContain('function collectUniqueGeneratedFileLines');
    expect(popup).toContain('collectUniqueGeneratedFileLines(response.files)');
    expect(popup).not.toContain('Object.values(response.files || {}).filter');
  });

  it('keeps the latest workflow result available for save-and-generate flow', () => {
    const sidepanel = readText('extension/sidepanel/sidepanel.js');

    expect(sidepanel).toContain('function renderWorkflowResults(result) {');
    expect(sidepanel).toContain('lastWorkflowResult = result || null;');
    expect(sidepanel).toContain('没有可保存的探索结果，请先完成一次网站探索');
    expect(sidepanel).not.toContain('if (!lastWorkflowResult || !currentSiteKey) return;');
  });

  it('restores the generate button from persisted site memory', () => {
    const sidepanel = readText('extension/sidepanel/sidepanel.js');
    const html = readText('extension/sidepanel/sidepanel.html');

    expect(sidepanel).toContain('async function syncGenerateButtonFromSiteMemory');
    expect(sidepanel).toContain("button.hidden = false;");
    expect(sidepanel).toContain('await syncGenerateButtonFromSiteMemory();');
    expect(html).toContain('id="btnExploreGenerate">智能生成</button>');
    expect(html).toContain('id="btnExploreQuickGenerate">快速生成</button>');
    expect(html).not.toContain('id="btnExploreGenerate" hidden');
    expect(sidepanel).not.toContain("document.getElementById('btnExploreGenerate').hidden = true");
  });

  it('auto-saves the latest workflow result before generating tools', () => {
    const sidepanel = readText('extension/sidepanel/sidepanel.js');
    const html = readText('extension/sidepanel/sidepanel.html');

    expect(html).toContain('生成前会自动保存本次探索结果');
    expect(html).toContain('仅保存探索结果');
    expect(sidepanel).toContain('async function ensureMemoryBeforeGenerate');
    expect(sidepanel).toContain('const saveResult = await ensureMemoryBeforeGenerate();');
    expect(sidepanel).toContain('正在自动保存探索结果');
    expect(sidepanel).toContain('生成前保存探索结果失败');
  });

  it('fails fast when bridge is disconnected before generation or AI config actions', () => {
    const sidepanel = readText('extension/sidepanel/sidepanel.js');
    const background = readText('extension/background/service-worker.js');

    expect(background).toContain('popup_bridge_status');
    expect(sidepanel).toContain('let isBridgeConnected = false;');
    expect(sidepanel).toContain('isBridgeConnected = Boolean(connected);');
    expect(sidepanel).toContain("type: 'popup_bridge_status'");
    expect(sidepanel).toContain('async function ensureBridgeConnected');
    expect(sidepanel).toContain("await ensureBridgeConnected('Bridge 未连接，无法生成工具')");
    expect(sidepanel).toContain('Bridge 未连接，无法写入生成工具');
    expect(sidepanel).toContain('Bridge 未连接，无法保存配置');
    expect(sidepanel).toContain('Bridge 未连接，无法测试配置');
  });

  it('surfaces adapter injection errors in the use tab', () => {
    const sidepanel = readText('extension/sidepanel/sidepanel.js');
    const background = readText('extension/background/service-worker.js');

    expect(background).toContain('const adapterInjectionStatus = new Map();');
    expect(background).toContain('function getAdapterInjectionError');
    expect(background).toContain('injectionError: resolved.adapterId ? getAdapterInjectionError(resolved.adapterId) :');
    expect(sidepanel).toContain('options.injectionError');
    expect(sidepanel).toContain('适配器加载失败');
    expect(sidepanel).toContain('已发现适配器，但注入当前页面失败');
  });

  it('warns when scaffold files were written but runtime tools are not registered yet', () => {
    const sidepanel = readText('extension/sidepanel/sidepanel.js');

    expect(sidepanel).toContain('当前页面尚未注册到可用工具');
    expect(sidepanel).toContain('若显示“适配器加载失败”，优先按错误信息检查生成文件');
    expect(sidepanel).toContain('当前没有可刷新的匹配页面');
  });

  it('keeps API candidate descriptions and blocks skip while capture is busy', () => {
    const sidepanel = readText('extension/sidepanel/sidepanel.js');

    expect(sidepanel).toContain("why: item.why || item.purpose || item.description || item.summary || item.reason || ''");
    expect(sidepanel).toContain("const skipBtn = document.getElementById('btnSkipCapture');");
    expect(sidepanel).toContain('skipBtn.disabled = isBusy;');
    expect(sidepanel).toContain("document.getElementById('actionCaptureStatus').addEventListener('click'");
    expect(sidepanel).toContain("data-capture-action=\"next-capture\"");
  });

  it('persists structural response evidence without raw previews for list API candidates', () => {
    const background = readText('extension/background/service-worker.js');
    const storedCandidateSource = background.slice(
      background.indexOf('function mergeStoredListCandidateEvidence('),
      background.indexOf('function extractStoredListApiCandidates('),
    );

    expect(storedCandidateSource).toContain('function createStoredListCandidate');
    expect(storedCandidateSource).toContain('responseHints: extractStoredActionResponseHints(entry?.responsePreview)');
    expect(storedCandidateSource).toContain('candidate.responseHints = mergeStoredActionResponseHints(');
    expect(storedCandidateSource).toContain('responseContentType: safeStoredText(entry?.responseContentType || entry?.contentType)');
    expect(storedCandidateSource).not.toMatch(/\bresponsePreview\s*:|\.responsePreview\s*=/);
    expect(background).toContain('mergeStoredListCandidateEvidence(existing, entry)');
  });

  it.each([false, true])('keeps list response hints but excludes captured values (merge=%s)', (merge) => {
    const buildStoredSiteMemory = loadStoredMemoryBuilder();
    const entry = {
      url: 'https://example.com/api/list',
      method: 'GET',
      responseContentType: 'application/json',
      status: 200,
      responsePreview: JSON.stringify({ data: { rows: [{
        id: 'fixture-record-private',
        title: 'fixture-title-private',
        email: 'fixture-person@example.com',
      }] } }),
    };
    const memory = buildStoredSiteMemory('example.com', {
      opened: { url: 'https://example.com/search' },
      actions: merge ? [{
        step: 'search',
        networkDelta: { entries: [{ ...entry, responsePreview: '{}' }] },
      }] : [],
      network: { entries: [entry] },
    });

    expect(memory.listApiCandidates).toHaveLength(1);
    const [candidate] = memory.listApiCandidates;
    expect(candidate.responseHints).toMatchObject({
      listPath: 'data.rows',
      itemKeys: ['id', 'title', 'email'],
      preferredIdKey: 'id',
      preferredDisplayKey: 'title',
    });
    expect(candidate.responseContentType).toBe('application/json');
    expect(candidate.sourceSteps).toEqual(merge ? ['search', 'passive_capture'] : ['passive_capture']);
    expect(candidate).not.toHaveProperty('responsePreview');
    const serialized = JSON.stringify(memory);
    for (const value of ['fixture-record-private', 'fixture-title-private', 'fixture-person@example.com']) {
      expect(serialized).not.toContain(value);
    }
  });
});
