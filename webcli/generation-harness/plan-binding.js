// Plan indexes refer to the original generation context, never to ranked slots.
export function plannedToolNames(siteKey, plan) {
  return (plan?.tools || []).map((tool) => `${siteKey}.${String(tool.name || '').split('.').pop()}`);
}

export function bindGenerationPlan(memory, plan) {
  const names = plannedToolNames(memory.siteKey, plan);
  if (!names.length || new Set(names).size !== names.length
    || names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name.slice(memory.siteKey.length + 1)))) {
    throw new Error('generation plan requires unique snake_case tool names');
  }
  const lists = [];
  const actions = [];
  const overrides = [];
  for (const [position, tool] of plan.tools.entries()) {
    const name = names[position];
    if (name === `${memory.siteKey}.check_login_status` && tool.risk === 'read') continue;
    if (!['read', 'write'].includes(tool.risk)) throw new Error(`invalid planned risk: ${name}`);
    const indexes = tool.sourceApiIndexes;
    if (!Array.isArray(indexes) || indexes.length !== 1 || !Number.isInteger(indexes[0])) {
      throw new Error(`planned tool requires exactly one source API index: ${name}`);
    }
    const candidates = tool.risk === 'write' ? memory.actionApiCandidates : memory.listApiCandidates;
    const candidate = candidates?.[indexes[0]];
    if (!candidate?.url) throw new Error(`planned source API not found: ${name}`);
    let sourceToolName;
    if (tool.risk === 'write') {
      if (!candidate.toolName) throw new Error(`planned action has no tool name: ${name}`);
      sourceToolName = candidate.toolName;
      actions.push(candidate);
    } else {
      if (lists.length >= 2) throw new Error('generation plan supports at most two read API tools');
      sourceToolName = `${memory.siteKey}.${lists.length ? 'fetch_summary_groups' : 'search_records'}`;
      lists.push(candidate);
    }
    if (overrides.some((item) => item.sourceToolName === sourceToolName)) {
      throw new Error(`duplicate planned source tool: ${name}`);
    }
    overrides.push({ sourceToolName, toolName: name, description: tool.purpose || '' });
  }
  return {
    ...memory,
    generationPlanBound: true,
    generationPlanToolNames: names,
    listApiCandidates: lists,
    actionApiCandidates: actions,
    actionCaptureHistory: [],
    actionEvidenceSummary: undefined,
    detailHints: { networkDetailCandidates: [] },
    scaffoldSemanticHints: {
      ...memory.scaffoldSemanticHints,
      analysisSource: 'harness_plan',
      toolOverrides: overrides,
    },
  };
}
