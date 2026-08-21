export function appendNodeOption(existing, option) {
  const trimmed = typeof existing === "string" ? existing.trim() : "";
  return trimmed.length > 0 ? `${trimmed} ${option}` : option;
}
