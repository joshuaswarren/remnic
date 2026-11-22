
export type ParseEnvelopeActorResult =
  | { ok: true; actor: string }
  | { ok: false; error: "missing_actor" | "invalid_actor" };

export function parseEnvelopeActor(value: string): ParseEnvelopeActorResult {
  const actor = value.trim();
  if (actor.length === 0) return { ok: false, error: "missing_actor" };
  if (actor.includes("\n")) return { ok: false, error: "invalid_actor" };
  return { ok: true, actor };
}
