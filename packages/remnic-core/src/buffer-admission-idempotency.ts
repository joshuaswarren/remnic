/** Fields on {@link BufferState} used by observe-buffer idempotency (#3368). */
export interface BufferAdmissionIdempotencyState {
  admissionIdempotency?: Record<string, number>;
  admissionIdempotencyOrder?: string[];
}

export const BUFFER_ADMISSION_IDEMPOTENCY_CAP = 512;

/** Client observe idempotency keys are namespaced by durable capture scope. */
export function scopeObserveBufferAdmissionIdempotencyKey(input: {
  sessionKey: string;
  writeNamespace: string;
  principal?: string;
  clientKey: string;
}): string {
  const principal = input.principal?.trim() ?? "";
  const client = input.clientKey.trim();
  return `obs\u001f${input.writeNamespace}\u001f${principal}\u001f${input.sessionKey}\u001e${client}`;
}

export function ensureAdmissionIdempotencyMap(state: BufferAdmissionIdempotencyState): Record<string, number> {
  const existing = state.admissionIdempotency;
  if (existing && Object.getPrototypeOf(existing) === null) return existing;
  // SAFETY: prototype-free map contract for observe idempotency keys (#3368).
  const map = Object.create(null) as Record<string, number>;
  if (existing) {
    for (const key of Object.keys(existing)) {
      if (Object.hasOwn(existing, key)) map[key] = existing[key]!;
    }
  }
  state.admissionIdempotency = map;
  return map;
}

export function ensureAdmissionIdempotencyOrder(state: BufferAdmissionIdempotencyState): string[] {
  if (!state.admissionIdempotencyOrder) state.admissionIdempotencyOrder = [];
  return state.admissionIdempotencyOrder;
}

export function hasBufferedAdmissionIdempotencyKey(state: BufferAdmissionIdempotencyState, key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const map = state.admissionIdempotency;
  return map !== undefined && Object.hasOwn(map, trimmed);
}

export function recordBufferedAdmissionIdempotencyKey(state: BufferAdmissionIdempotencyState, key: string, turnCount: number): void {
  const trimmed = key.trim();
  if (!trimmed || turnCount <= 0) return;
  const map = ensureAdmissionIdempotencyMap(state);
  const order = ensureAdmissionIdempotencyOrder(state);
  map[trimmed] = turnCount;
  if (!order.includes(trimmed)) order.push(trimmed);
  while (order.length > BUFFER_ADMISSION_IDEMPOTENCY_CAP) {
    const evicted = order.shift();
    if (evicted !== undefined) delete map[evicted];
  }
}
