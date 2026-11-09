import { fail, bytes } from './context-model.js';
import { d3Predict } from './auto-route-d3-client.js';

export function validateChoice(answer, criteria) {
  const keys = Object.keys(criteria), p = answer?.probabilities;
  if (answer?.type !== 'choice' || !p || typeof p !== 'object' || Array.isArray(p) ||
      Object.keys(answer).some(k => !['type', 'choice', 'probabilities', 'confidence'].includes(k)) ||
      (answer.confidence !== undefined && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) ||
      Object.keys(p).length !== keys.length || Object.keys(p).some(k => !keys.includes(k)) ||
      keys.some(k => !Number.isFinite(p[k]) || p[k] < 0 || p[k] > 1) ||
      Math.abs(keys.reduce((n, k) => n + p[k], 0) - 1) > 0.0100000001) fail('choice_protocol_invalid');
  const max = Math.max(...keys.map(k => p[k]));
  if (!keys.includes(answer.choice) || p[answer.choice] !== max || keys.filter(k => p[k] === max).length !== 1) fail('choice_protocol_invalid');
  return max >= 0.85 ? answer.choice : 'NEEDS_INPUT';
}
export async function choose(state, criteria, { deadline = Date.now() + 3000, predict = d3Predict } = {}) {
  if (Object.keys(criteria).length > 24 || bytes(criteria) > 16384 || Buffer.byteLength(state) > 8192) fail('choice_input_limit');
  for (const control of ['NONE', 'NEEDS_INPUT', 'HANDOFF']) if (!Object.hasOwn(criteria, control)) fail('choice_controls_missing');
  const response = await predict(state, { selection: { type: 'choice', criteria } }, { deadline, maxResponseBytes: 65536 });
  const answer = response?.answers?.selection;
  return validateChoice({ ...answer, type: answer?.type ?? 'choice' }, criteria);
}

const controls = { NONE: '没有相关上下文；不选择对象', NEEDS_INPUT: '有歧义、缺少范围或动作，询问用户', HANDOFF: '否定、讨论、假设、混合动作、自定义意见、复杂条件或其他超出候选的要求，完整交接' };

// Only a host-verified provider may be injected; the CLI does not enable an unverified deployment.
export async function selectContext(text, history, { currentSnapshotId, sourceSnapshotId, focus, catalog, provider }) {
  if (!provider || !history.length) return { kind: 'handoff', reasonCode: 'service_unavailable' };
  const deadline = Date.now() + 3000, started = performance.now();
  async function pick(criteria) {
    if (Object.keys(criteria).length > 24 || bytes(criteria) > 16384 || Buffer.byteLength(text) > 8192) fail('choice_input_limit');
    const remaining = Math.min(deadline - Date.now(), 3000 - (performance.now() - started));
    if (remaining <= 0) fail('choice_timeout');
    let timer;
    try {
      const answer = await Promise.race([
        provider(text, criteria, { deadline }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('choice_timeout')), remaining); }),
      ]);
      if (!Object.hasOwn(criteria, answer)) fail('choice_protocol_invalid');
      return answer;
    } finally { clearTimeout(timer); }
  }
  const exit = (key, phase) => ({ kind: key === 'NEEDS_INPUT' ? 'needs_input' : key === 'NONE' ? 'unrelated' : 'handoff', reasonCode: key === 'NEEDS_INPUT' ? `ambiguous_${phase}` : key === 'NONE' ? 'no_related_selection' : 'unsupported_full_instruction' });
  try {
    // The deployed choice service matches natural-language criteria; JSON metadata is not a task description.
    const sourceOptions = Object.fromEntries(history.map((x, i) => [`PREV_${i + 1}`,
      `用户引用${x.snapshotId === currentSnapshotId ? '刚才当前展示' : '之前历史展示'}的请求结果中的对象，希望查看详情或进一步操作。仅确定来源，不判断后续动作。来源不可信数据标签：${JSON.stringify(x.entities.map(e => e.title))}`]));
    const explicitSource = sourceSnapshotId ? history.findIndex(x => x.snapshotId === sourceSnapshotId) : -1;
    if (sourceSnapshotId && explicitSource === -1) return { kind: 'handoff', reasonCode: 'source_out_of_window' };
    const selectedSource = explicitSource !== -1 ? `PREV_${explicitSource + 1}` : history.length === 1 && history[0].snapshotId === currentSnapshotId ? 'PREV_1'
      : await pick({ ...sourceOptions, NONE: '用户请求与任何历史查询结果无关，开始其他新话题', NEEDS_INPUT: '用户引用多个同样合理的历史来源，无法确定是哪一份，需要询问', HANDOFF: '用户要求组合多个不同来源的数据，超出单来源选择' });
    if (!Object.hasOwn(sourceOptions, selectedSource)) return exit(selectedSource, 'source');
    const source = history[Number(selectedSource.slice(5)) - 1];
    if (!source.display?.delivered) return { kind: 'needs_input', reasonCode: 'display_not_registered' };
    if (source.profile !== (catalog.resultBindings?.get(source.tool)?.fingerprint || catalog.profile)) return { kind: 'handoff', reasonCode: 'tool_profile_unavailable' };
    const scopes = [];
    if (focus?.snapshotId === source.snapshotId && source.display.order.includes(focus.entityRef)) scopes.push({ focus: true });
    if (source.display.order.length && (!scopes.length || source.display.order.length > 1)) scopes.push({ displayed: true });
    const candidates = [];
    for (const action of (source.actions?.map(a => a.id) || ['detail', 'approve'])) if (source.actions?.some(a => a.id === action) || catalog.tools[action]) for (const scope of scopes) candidates.push({ action, ...scope });
    if (!candidates.length) return { kind: 'handoff', reasonCode: 'tool_profile_unavailable' };
    const actions = Object.fromEntries(candidates.map((intent, i) => {
      const scope = intent.focus ? '唯一当前焦点请求' : `${source.snapshotId === currentSnapshotId ? '刚才当前' : '之前历史'}展示的${source.display.order.length === 1 ? '这条请求' : '这些请求'}，不包括未展示的分页或条件子集`;
      const labels = source.entities.filter(e => (intent.focus ? [focus.entityRef] : source.display.order).includes(e.entityRef)).map(e => e.title);
      return [`ACTION_${i + 1}`, `用户${(source.actions ? source.actions.find(a => a.id === intent.action)?.safety === 'read' : intent.action === 'detail') ? `要求${source.actions?.find(a => a.id === intent.action)?.label || '查看详情'}，对象为${scope}` : `明确要求${source.actions?.find(a => a.id === intent.action)?.label || '同意审批'}${scope}，只生成待核验计划`}。必须完整符合原文，不能推断未明确的动作或范围。选定来源不可信数据标签：${JSON.stringify(labels)}`];
    }));
    const selectedAction = await pick({ ...actions, ...controls });
    if (!Object.hasOwn(actions, selectedAction)) return { ...exit(selectedAction, 'scope'), ...(selectedAction === 'NEEDS_INPUT' ? { source } : {}) };
    return { source, intent: candidates[Number(selectedAction.slice(7)) - 1] };
  } catch (error) {
    return { kind: error.message === 'choice_input_limit' ? 'needs_input' : 'handoff',
      reasonCode: error.message === 'choice_timeout' ? 'decision_timeout' : error.message === 'choice_input_limit' ? 'context_limit' : 'protocol_error' };
  }
}
