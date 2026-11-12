import { randomUUID } from 'node:crypto';
import { beginRound, commitRound, sources, LIMITS, fail } from './context-model.js';
import { selectContext } from './context-choice.js';
import { validateToolArguments } from './generation-harness/tool-registry.js';

const number = text => ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[text] ?? Number(text));
export function parseIntent(text) {
  const value = text.trim().replace(/[。！!]$/, '');
  if (/^(?:取消|算了|cancel)$/i.test(value)) return { cancel: true };
  const action = /^(?:同意|审批同意)(.*)$/.exec(value) || /^(.*?)(?:审批同意|同意)$/.exec(value);
  const detail = /^(?:查看|看|打开)?(.*?)详情$/.exec(value) || /^(?:查看|看|打开)(.+)$/.exec(value);
  const process = /^处理(?:一下)?(.+?)(?:一下)?$/.exec(value);
  const match = action || detail || process;
  if (!match) return null;
  let scope = match[1].trim();
  const parsed = { action: action ? 'approve' : detail ? 'detail' : null };
  if (/^(?:前面|之前|上一份)(?:的)?/.test(scope)) {
    parsed.earlier = true;
    if (scope.startsWith('上一份')) parsed.previous = true;
    scope = scope.replace(/^(?:前面|之前|上一份)(?:的)?/, '');
  }
  if (/^(?:这条|这一条|当前这条|它|这个)$/.test(scope)) return { ...parsed, focus: true };
  if (/^(?:全部|所有|全部请求单|所有请求单)$/.test(scope)) return { ...parsed, all: true };
  const count = /^这([一二两三四五六七八九十\d]+)条$/.exec(scope);
  if (count) return { ...parsed, count: number(count[1]), displayed: true };
  if (/^(?:这些|当前展示的|这几条)$/.test(scope)) return { ...parsed, displayed: true };
  if (/^第[一二三四五六七八九十\d]+(?:[、,，和及](?:第)?[一二三四五六七八九十\d]+)*(?:条|项)$/.test(scope)) {
    const ordinals = scope.replace(/第|条|项/g, '').split(/[、,，和及]/).map(number);
    if (ordinals.every(n => Number.isInteger(n) && n >= 1 && n <= 20) && new Set(ordinals).size === ordinals.length) return { ...parsed, ordinals };
  }
  return null;
}
function declaredIntent(text, history) {
  const value = text.trim().replace(/[。！!]$/, '');
  const matches = [];
  for (const source of history) for (const action of source.actions || []) {
    if (!value.startsWith(action.label)) continue;
    const scope = parseIntent(`查看${value.slice(action.label.length)}`);
    if (scope?.action === 'detail') matches.push({ ...scope, action: action.id, declaredLabel: action.label });
  }
  const unique = [...new Map(matches.map(intent => [JSON.stringify(intent), intent])).values()];
  return unique.length === 1 ? unique[0] : null;
}
function argumentInput(source, intent, refs, catalog) {
  const binding = catalog.resultBindings?.get(source.tool);
  const rules = Number.isInteger(source.resultRuleIndex) ? [binding?.results[source.resultRuleIndex]].filter(Boolean) : binding?.results || [];
  const declared = source.actions.find(a => a.id === intent.action);
  const selected = refs.map(ref => source.entities.find(e => e.entityRef === ref)?.bindings?.[intent.action]);
  const variants = selected.map(b => b?.bindingIndex);
  if (variants.some(Number.isInteger) && (!variants.every(Number.isInteger) || new Set(variants).size !== 1 || rules.length !== 1)) return null;
  const candidates = rules.flatMap(r => r.actions).filter((a, index) => a.id === intent.action && a.label === declared?.label &&
    (Number.isInteger(variants[0]) ? index === variants[0] : a.tool === declared?.tool));
  if (candidates.some(a => JSON.stringify(a) !== JSON.stringify(candidates[0]))) return null;
  const action = candidates[0];
  if (!action) return null;
  const missing = (action.schema.required || []).filter(key => selected.some(b => b && !Object.hasOwn(b.args, key)));
  // IDs and provenance already declared in args can only be refreshed, never supplied as answers.
  const allowed = action.inputs || [];
  if (!missing.length || (!action.inputs && missing.length !== 1) || missing.some(key => !allowed.includes(key) || Object.hasOwn(action.args, key) ||
      !action.schema.properties?.[key]?.type || (!action.inputs && action.schema.properties[key].type !== 'string'))) return null;
  const partialSchema = { ...action.schema, required: (action.schema.required || []).filter(key => !missing.includes(key)) };
  if (selected.some(b => !b || Object.keys(action.args).some(key => !Object.hasOwn(b.args, key) || b.args[key] === undefined) ||
      validateToolArguments(b.args, partialSchema).length)) return null;
  const format = missing.length === 1 && action.schema.properties[missing[0]].type === 'string' ? 'text' : 'json';
  return { field: missing.length === 1 ? missing[0] : '$arguments', fields: missing, format, schema: action.schema,
    description: missing.map(key => action.schema.properties[key].description || key).join('、') };
}
function argumentAnswer(input, answer) {
  if (!input.fields || input.format === 'text') return { [input.field]: answer };
  try {
    const parsed = JSON.parse(answer);
    const values = input.fields.length === 1 ? { [input.field]: parsed } : parsed;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !input.fields.includes(key))) return {};
    return values;
  } catch { return {}; }

}
function selectionRefs(s, intent, source) {
  const display = source.display;
  if (!display?.delivered) return null;
  if (intent.focus) return s.focus?.snapshotId === source.snapshotId ? [s.focus.entityRef] : display.order.length === 1 ? display.order : null;
  if (intent.ordinals) return intent.ordinals.map(n => display.order[n - 1]);
  if (intent.all && display.completeness !== 'complete') return null;
  if (intent.count && intent.count !== display.order.length) return null;
  return display.order;
}
function clarification(s, intent, source, reason, candidates = [], originalText = null) {
  const clarificationId = randomUUID();
  const missingFields = reason === 'ambiguous_scope' ? ['actionId', 'scope']
    : [reason === 'action_required' ? 'actionId' : reason === 'scope_ambiguous' ? 'scope' : 'source'];
  const sourceOptions = candidates.length <= 24 ? candidates.map((x, i) => ({ id: `source_${i + 1}`, label: `第${i + 1}份列表（${x.display?.order.length ?? 0}条已展示）`, snapshotId: x.snapshotId, sourceRoundId: x.sourceRoundId,
    capturedAt: x.capturedAt, displayVersion: x.display?.version })) : [];
  const options = reason === 'action_required' && source?.actions ? source.actions.map(a => ({ id: a.id, label: a.label })) : reason === 'action_required' ? [{ id: 'refresh', label: '重新查询' }, { id: 'handoff', label: '交给 Agent 处理' }]
    : sourceOptions.length ? sourceOptions : [{ id: 'refresh', label: '重新查询' }, { id: 'handoff', label: '交给 Agent 处理' }];
  const refs = source && intent ? selectionRefs(s, intent, source) : null;
  const knownSelection = source ? { snapshotId: source.snapshotId, sourceRoundId: source.sourceRoundId,
    displayVersion: source.display?.version, ...(refs?.length && refs.every(Boolean) ? { entityRefs: refs } : {}) } : undefined;
  s.pendingIntent = { clarificationId, intent, snapshotId: source?.snapshotId,
    sourceRoundId: source?.sourceRoundId, displayVersion: source?.display?.version, roundId: s.activeRound.roundId, missingFields, options,
    originalText: intent ? null : originalText };
  return { kind: 'needs_input', reasonCode: reason, clarificationId, missingFields, knownSelection,
    question: reason === 'action_required' ? (source?.actions ? `请选择动作：${source.actions.map(a => a.label).join(' / ')}。` : '请重新查询或明确动作。')
      : sourceOptions.length ? '请选择引用哪份列表；序号按该列表已登记的展示顺序解释。'
      : reason === 'ambiguous_scope' ? '请明确动作和范围，例如“查看第一条”或“同意这3条”。'
      : reason === 'scope_ambiguous' ? '请明确序号或当前展示范围，也可重新查询或交给 Agent 处理。' : '请重新查询，或交给 Agent 处理。', options };
}
export async function routeContext(s, text, { now = Date.now(), catalog, replyTo, provider } = {}) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > LIMITS.input) fail('context_input_limit', 2);
  const oldPending = s.pendingIntent;
  if (replyTo && replyTo !== oldPending?.clarificationId) fail('context_stale_clarification', 4);
  let intent = parseIntent(text) || declaredIntent(text, sources(s, now));
  const answer = text.trim();
  const sourceNumber = /^第([一二三\d]+)份(?:列表)?$/.exec(answer);
  const option = oldPending?.options?.find(o => o.id === answer || o.label === answer ||
    (answer === '同意' && o.id === 'agree') || (sourceNumber && o.id === `source_${number(sourceNumber[1])}`));
  const scopeIntent = oldPending?.missingFields?.includes('scope') && oldPending.intent && parseIntent(`查看${answer}`);
  const scopeAnswer = scopeIntent?.action === 'detail' && !scopeIntent.earlier ? scopeIntent : null;
  const completeAnswer = oldPending && !oldPending.intent && oldPending.snapshotId && intent?.action && !intent.earlier ? intent : null;
  const inputAnswer = !!replyTo && typeof oldPending?.argumentInput?.field === 'string' && !intent?.cancel && !option;
  const cancelAnswer = !!replyTo && !!intent?.cancel;
  const pendingAnswer = !!option || !!scopeAnswer || !!completeAnswer || !!inputAnswer || cancelAnswer;
  if (replyTo && !pendingAnswer) fail('context_invalid_clarification_answer', 2);
  const lifecycle = beginRound(s, text, now, { freshRead: !!intent?.fresh });
  const history = sources(s, now);
  const roundId = s.activeRound.roundId;
  let source, resumeText, suppliedArguments;
  if (pendingAnswer && !cancelAnswer) {
    source = history.find(x => x.snapshotId === (option?.snapshotId || oldPending.snapshotId));
    if (option?.id === 'refresh') intent = { fresh: true };
    else if (option?.id === 'handoff') intent = { cancel: true };
    else if (source && source.display?.version === (option?.snapshotId ? option.displayVersion : oldPending.displayVersion)) {
      if (inputAnswer) {
        intent = oldPending.intent;
        suppliedArguments = argumentAnswer(oldPending.argumentInput, answer);
      } else if (completeAnswer) intent = completeAnswer;
      else if (oldPending.intent) intent = scopeAnswer ? { ...scopeAnswer, action: oldPending.intent.action }
        : { ...oldPending.intent, ...((source.actions?.some(a => a.id === option?.id) || ['agree', 'detail'].includes(option?.id)) ? { action: option.id === 'agree' ? 'approve' : option.id } : {}) };
      else { intent = null; resumeText = oldPending.originalText; }
    } else intent = null;
  }
  s.pendingIntent = null;
  let result = option?.id === 'handoff' || option?.id === 'refresh'
    ? { kind: 'handoff', reasonCode: option.id === 'refresh' ? 'refresh_requested' : 'user_requested_handoff' } : null;
  if (!intent && /(?:不要|不想|别|不能|如果|假如|讨论|会怎样|意见|拒绝|转派|并且|然后|同时|删除|[，,;；])/.test(text)) {
    result = { kind: 'handoff', reasonCode: 'unsupported_full_instruction' };
  }
  if (!result && !intent && (!pendingAnswer || resumeText) && provider && history.length) {
    const chosen = await selectContext(resumeText || text, history, { currentSnapshotId: s.currentSnapshotId,
      sourceSnapshotId: resumeText ? source.snapshotId : undefined, focus: s.focus, catalog, provider });
    if (chosen.intent) { intent = chosen.intent; source = chosen.source; }
    else result = chosen.kind === 'needs_input' ? clarification(s, null, chosen.source, chosen.reasonCode,
      chosen.reasonCode === 'ambiguous_source' ? history : [], resumeText || text) : chosen;
  }
  if (!result && resumeText && !provider) result = { kind: 'handoff', reasonCode: 'service_unavailable' };
  if (result) { /* Provider exit is a complete decision, never a partial command. */ }
  else if (intent?.cancel) result = { kind: 'handoff', reasonCode: 'intent_cancelled' };
  else if (intent?.fresh) {
    s.currentSnapshotId = null; s.focus = null;
    result = { kind: 'unrelated', reasonCode: 'independent_query' };
  } else if (!intent) {
    result = { kind: history.length || pendingAnswer ? 'handoff' : 'unrelated', reasonCode: pendingAnswer ? 'source_out_of_window' : 'unsupported_full_instruction' };
  } else {
    if (!source && intent.focus && !intent.earlier && s.focus) source = history.find(x => x.snapshotId === s.focus.snapshotId);
    if (!source && !intent.earlier) source = history.find(x => x.snapshotId === s.currentSnapshotId);
    if (!source && intent.earlier) {
      const older = history.filter(x => x.snapshotId !== s.currentSnapshotId);
      if (intent.previous) source = older.at(-1);
      else if (older.length === 1) source = older[0];
    }
    if (!source) result = clarification(s, intent, null, 'source_ambiguous_or_unavailable', history.filter(x => !intent.earlier || x.snapshotId !== s.currentSnapshotId));
    else if (!source.actions && catalog.resultBindings?.has(source.tool)) result = { kind: 'handoff', reasonCode: 'tool_profile_unavailable' };
    else if (!source.display?.delivered) result = clarification(s, intent, source, 'display_not_registered');
    else if (intent.declaredLabel && !source.actions?.some(a => a.id === intent.action && a.label === intent.declaredLabel)) result = { kind: 'handoff', reasonCode: 'tool_profile_unavailable' };
    else if (!intent.action) result = clarification(s, intent, source, 'action_required');
    else {
      if (source.actions) {
        const binding = catalog.resultBindings?.get(source.tool);
        catalog = { ...catalog, profile: binding?.fingerprint, tools: Object.fromEntries(source.actions.map(a => [a.id, { name: a.tool, fingerprint: binding?.fingerprint }])) };
      }
      const display = source.display;
      const refs = selectionRefs(s, intent, source);
      const currentInput = suppliedArguments && refs?.length ? argumentInput(source, intent, refs, catalog) : null;
      if (!refs?.length || refs.some(x => !x) || (intent.count && intent.count !== refs.length)) result = clarification(s, intent, source, 'scope_ambiguous');
      else if (source.profile !== catalog.profile || !catalog.tools[intent.action]) result = { kind: 'handoff', reasonCode: 'tool_profile_unavailable' };
      else if (source.actions && refs.some(ref => {
        const bound = source.entities.find(e => e.entityRef === ref)?.bindings?.[intent.action];
        if (suppliedArguments) return !bound || !currentInput || currentInput.field !== oldPending.argumentInput.field ||
          Object.keys(suppliedArguments).some(key => !(currentInput.fields || [currentInput.field]).includes(key)) || validateToolArguments({ ...bound.args, ...suppliedArguments }, currentInput.schema).length;
        return !bound?.ready;
      })) {
        result = clarification(s, intent, source, 'binding_arguments_missing');
        const input = argumentInput(source, intent, refs, catalog);
        result.missingFields = input ? input.fields.map(field => `arguments.${field}`) : ['arguments'];
        if (input) result.inputMode = 'text';
        result.question = input ? `请提供${input.description}${input.format === 'json' ? `，使用JSON${input.fields.length > 1 ? '对象，字段：' + input.fields.join('、') : '值'}` : ''}；已保留所选对象，答复仅用于生成计划。` : '结果参数不完整，请重新查询，或交给 Agent 补全；不会派发不完整的调用。';
        s.pendingIntent.missingFields = result.missingFields;
        if (input) s.pendingIntent.argumentInput = input;
      }
      else {
        const selection = refs.map(ref => source.entities.find(e => e.entityRef === ref));
        if (selection.some(x => !x)) fail('context_corrupt');
        const decisionId = randomUUID();
        const steps = selection.map((e, i) => {
          const stepId = `s${i + 1}`;
          const bound = e.bindings?.[intent.action];
          if (source.actions && !bound?.ready && !suppliedArguments) fail('context_binding_not_executable');
          if (!bound) fail('context_binding_not_executable');
          const tool = bound.tool || catalog.tools[intent.action].name;
          const args = { ...bound.args, ...suppliedArguments };
          return { stepId, tool, args, businessId: e.businessId, toolFingerprint: catalog.tools[intent.action].fingerprint,
            fieldSources: Object.fromEntries(Object.keys(args).map(key => [key, suppliedArguments && Object.hasOwn(suppliedArguments, key) ? 'explicit_user_input' : 'declared_result_binding'])),
            invocation: { command: 'call', tool, args, decision: decisionId, step: stepId } };
        });
        const writeAction = source.actions ? source.actions.find(a => a.id === intent.action)?.safety !== 'read' : intent.action === 'approve';
        const decision = { decisionId, roundId, action: intent.action,
          source: { snapshotId: source.snapshotId, sourceRoundId: source.sourceRoundId, displayVersion: display.version },
          selection, steps, executionEligibility: writeAction ? 'write_allowed' : 'read_only_allowed',
          reasonCode: writeAction ? 'verified_write_binding' : 'verified_read_binding' };
        s.preparedDecision = decision;
        result = { kind: 'resolved', ...decision };
      }
    }
  }
  if (result.kind === 'unrelated') { s.currentSnapshotId = null; s.focus = null; }
  commitRound(s);
  const envelope = { contextProtocolVersion: 1, ...result, context: { epoch: s.sessionEpoch, revision: s.revision + 1,
    roundId, state: lifecycle, historyAvailable: history.length > 0 } };
  if (result.kind === 'resolved') {
    envelope.selection = { ...result.source, entityRefs: result.selection.map(e => e.entityRef), actionId: result.action };
    envelope.decision = { ...s.preparedDecision, version: 1 };

  }
  if (result.recommendation) envelope.singleTurnRoute = result.recommendation;
  return envelope;
}
