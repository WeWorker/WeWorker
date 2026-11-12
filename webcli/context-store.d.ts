export interface ContextState {
  hostLedger?: unknown;
  operationGuards: Array<Record<string, unknown>>;
  lastInteractionAt: number;
  status: string;
}
export class ContextStore {
  constructor(options?: { root?: string; now?: () => number });
  transaction<T>(id: string, update: (state: ContextState) => T | Promise<T>, options?: { create?: boolean; collect?: boolean; epoch?: string; revision?: number }): Promise<T>;
  verifyOperation(id: string, options: { epoch: string; operationId: string; verify: (guard: Record<string, unknown>) => Promise<{ operationId: string; requestId: string; profile: string; status: string }> }): Promise<unknown>;
}
