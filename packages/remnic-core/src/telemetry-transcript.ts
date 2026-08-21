const TELEMETRY_TURN_MARKER = /^\[(?:user|assistant|system)\]\s+\[(?:action|observation|state|reward|step|turn|frame)\s+\d+\]:/i;
const BARE_TELEMETRY_MARKER = /^\[(?:action|observation|state|reward|step|turn|frame)\s+\d+\]:/i;
const DURABLE_MEMORY_CUE_PHRASES = [
  "remember",
  "don't forget",
  "prefer",
  "preference",
  "decided",
  "decision",
  "deadline",
  "commitment",
  "promise",
  "my name",
  "i am",
  "i work",
  "we use",
  "correction",
  "actually",
  "always",
  "never",
  "when you",
];

export function stripRolePrefix(line: string): string {
  return line.replace(/^\[(?:user|assistant|system)\]\s+/i, "").trim();
}

export function isTelemetryMarkerLine(line: string): boolean {
  return TELEMETRY_TURN_MARKER.test(line) ||
    BARE_TELEMETRY_MARKER.test(stripRolePrefix(line));
}

export function isMechanicalTelemetryLine(line: string): boolean {
  const stripped = stripRolePrefix(line);
  return (
    isTelemetryMarkerLine(line) ||
    /^(?:left|right|up|down|wait|noop|stop|start|forward|backward)$/i.test(stripped) ||
    /^(?:active rules|objects on (?:the )?map|inventory|score|reward|position|location):?$/i.test(stripped) ||
    /^rule `[^`]+`/i.test(stripped) ||
    /^(?:[a-z][\w-]*|\w+ `[^`]+`)\s+\d+\s+steps?\s+(?:to\s+the\s+)?(?:left|right|up|down)\b/i.test(stripped)
  );
}

export function hasDurableMemoryCue(conversation: string): boolean {
  const lower = conversation.toLowerCase();
  if (DURABLE_MEMORY_CUE_PHRASES.some((phrase) => lower.includes(phrase))) {
    return true;
  }
  const ifIndex = lower.indexOf("if ");
  return ifIndex >= 0 && lower.indexOf(" then", ifIndex + 3) >= 0;
}

export function looksLikeMechanicalTelemetryTranscript(
  conversation: string,
): boolean {
  if (hasDurableMemoryCue(conversation)) return false;

  const lines = conversation
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 8) return false;

  const markerLines = lines.filter((line) => isTelemetryMarkerLine(line)).length;
  if (markerLines < 4) return false;

  const mechanicalLines = lines.filter((line) => isMechanicalTelemetryLine(line)).length;
  const mechanicalRatio = mechanicalLines / lines.length;
  return mechanicalRatio >= 0.45;
}
