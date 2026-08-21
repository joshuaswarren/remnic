/**
 * Markdown renderer for a recall navigate step (issue #1956 leftover).
 *
 * Deterministic. Surfaces wait. Empty children prints (empty).
 */

export type NavigateResult = {
  action: string;
  nodeId: string;
  children?: readonly string[];
  path?: readonly string[];
  stopReason: string;
};

function formatList(items: readonly string[] | undefined): string {
  if (items === undefined || items.length === 0) return "(empty)";
  return items.join(", ");
}

export function renderNavigateResult(result: NavigateResult): string {
  const usePath = result.action === "traverse" || result.path !== undefined;
  return [
    "# Navigate",
    "",
    `- action: ${result.action}`,
    `- nodeId: ${result.nodeId}`,
    usePath ? `- path: ${formatList(result.path)}` : `- children: ${formatList(result.children)}`,
    `- stop: ${result.stopReason}`,
    "",
  ].join("\n");
}
