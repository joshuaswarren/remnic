
export type ParseRequiredActorResult =
  | { ok: true; required: string }
  | { ok: false; error: "invalid_required" };

export function parseRequiredActor(value: string): ParseRequiredActorResult {
  const required = value.trim();
  if (required.includes("\n")) return { ok: false, error: "invalid_required" };
  return { ok: true, required };
}
