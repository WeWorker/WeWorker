import {
  analyzeApiEvidenceEntry,
  analyzeApiExplorationWorkflow,
  type ApiEndpointEvidence,
  type ApiExplorationAnalysisV2,
  type RawApiEvidenceEntry,
} from './api-exploration-evidence.js'

export interface ExplorationBenchmarkSide {
  label: string
  endpoints: Array<{
    family: string
    verdict: string
    score: number
    method: string
    path: string
  }>
}

export interface ExplorationBenchmarkReport {
  schemaVersion: 1
  weworker: ExplorationBenchmarkSide
  opencli: ExplorationBenchmarkSide
  overlap: string[]
  onlyWeWorker: string[]
  onlyOpenCli: string[]
  endpointUnionCount: number
  overlapRate: number
  verdictDifferences: Array<{ family: string; weworker: string; opencli: string }>
}

function asEntries(input: unknown): RawApiEvidenceEntry[] {
  if (Array.isArray(input)) return input.filter((item): item is RawApiEvidenceEntry => Boolean(item && typeof item === 'object'))
  if (!input || typeof input !== 'object') return []
  const record = input as Record<string, unknown>
  if (Array.isArray(record.entries)) return asEntries(record.entries)
  if (record.network && typeof record.network === 'object') return asEntries((record.network as Record<string, unknown>).entries)
  return []
}

function normalizeOpenCliEntry(entry: RawApiEvidenceEntry & Record<string, unknown>): RawApiEvidenceEntry {
  return {
    ...entry,
    method: typeof entry.method === 'string' ? entry.method : 'GET',
    responseContentType: typeof entry.responseContentType === 'string'
      ? entry.responseContentType
      : (typeof entry.ct === 'string' ? entry.ct : ''),
    responsePreview: typeof entry.responsePreview === 'string'
      ? entry.responsePreview
      : (typeof entry.body === 'string' ? entry.body : ''),
  }
}

function analysisSide(label: string, analysis: ApiExplorationAnalysisV2): ExplorationBenchmarkSide {
  return {
    label,
    endpoints: analysis.candidates
      .filter((candidate) => candidate.verdict !== 'noise')
      .map((candidate) => ({
        family: candidate.endpointFamily,
        verdict: candidate.verdict,
        score: candidate.score,
        method: candidate.method,
        path: candidate.path,
      })),
  }
}

function openCliSide(input: unknown): ExplorationBenchmarkSide {
  const byFamily = new Map<string, ApiEndpointEvidence>()
  for (const entry of asEntries(input).map((item) => normalizeOpenCliEntry(item as RawApiEvidenceEntry & Record<string, unknown>))) {
    const evidence = analyzeApiEvidenceEntry(entry, ['opencli_network'])
    const existing = byFamily.get(evidence.endpointFamily)
    if (!existing || evidence.score > existing.score) byFamily.set(evidence.endpointFamily, evidence)
  }
  return analysisSide('opencli', {
    schemaVersion: 2,
    candidates: [...byFamily.values()],
    likelyDataCount: 0,
    maybeDataCount: 0,
    noiseCount: 0,
    blockedCount: 0,
    recommendedNextProbe: 'no_usable_api',
  })
}

export function buildApiExplorationBenchmark(
  weworkerInput: Record<string, unknown> | ApiExplorationAnalysisV2,
  opencliInput: unknown,
): ExplorationBenchmarkReport {
  const weworkerAnalysis = (weworkerInput as ApiExplorationAnalysisV2).schemaVersion === 2
    && Array.isArray((weworkerInput as ApiExplorationAnalysisV2).candidates)
    ? weworkerInput as ApiExplorationAnalysisV2
    : analyzeApiExplorationWorkflow(weworkerInput as Record<string, unknown>)
  const weworker = analysisSide('weworker', weworkerAnalysis)
  const opencli = openCliSide(opencliInput)
  const weworkerMap = new Map(weworker.endpoints.map((endpoint) => [endpoint.family, endpoint]))
  const opencliMap = new Map(opencli.endpoints.map((endpoint) => [endpoint.family, endpoint]))
  const overlap = [...weworkerMap.keys()].filter((family) => opencliMap.has(family)).sort()
  const onlyWeWorker = [...weworkerMap.keys()].filter((family) => !opencliMap.has(family)).sort()
  const onlyOpenCli = [...opencliMap.keys()].filter((family) => !weworkerMap.has(family)).sort()
  const endpointUnionCount = new Set([...weworkerMap.keys(), ...opencliMap.keys()]).size
  const verdictDifferences = overlap.flatMap((family) => {
    const left = weworkerMap.get(family)
    const right = opencliMap.get(family)
    return left && right && left.verdict !== right.verdict
      ? [{ family, weworker: left.verdict, opencli: right.verdict }]
      : []
  })
  return {
    schemaVersion: 1,
    weworker,
    opencli,
    overlap,
    onlyWeWorker,
    onlyOpenCli,
    endpointUnionCount,
    overlapRate: endpointUnionCount === 0 ? 1 : Number((overlap.length / endpointUnionCount).toFixed(4)),
    verdictDifferences,
  }
}
