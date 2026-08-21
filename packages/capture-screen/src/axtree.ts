/**
 * Accessibility-tree text extraction. Walks a macOS AX-tree JSON snapshot and
 * concatenates the visible text, with three safety filters baked in:
 *
 *   - AXSecureTextField nodes are skipped entirely (never read a password box),
 *     including their subtree.
 *   - Off-screen nodes (`offScreen: true`) are skipped with their subtree — text
 *     the user cannot see is not "on screen".
 *   - Traversal is bounded to `maxNodes` visited nodes, so a pathological tree
 *     cannot exhaust memory/CPU; the result is flagged `truncated` when the cap
 *     is hit.
 *
 * The shape is intentionally permissive: real AX dumps carry many roles and the
 * text can live on any of value/title/description/label. Unknown fields are
 * ignored.
 */

export const SECURE_ROLE = "AXSecureTextField";

export interface AxNode {
  role?: string;
  value?: string;
  title?: string;
  description?: string;
  label?: string;
  offScreen?: boolean;
  children?: AxNode[];
}

export interface AxExtractResult {
  text: string;
  /** Nodes actually visited (bounded by maxNodes). */
  nodes: number;
  /** True when the maxNodes cap stopped traversal before the tree was exhausted. */
  truncated: boolean;
}

function nodeText(node: AxNode): string {
  const pieces: string[] = [];
  for (const field of [node.value, node.title, node.description, node.label]) {
    if (typeof field === "string" && field.trim().length > 0) pieces.push(field.trim());
  }
  return pieces.join(" ");
}

/**
 * Extract visible, non-secure text from an AX tree. Iterative DFS with an
 * explicit stack so a deep tree cannot overflow the call stack, and a visited
 * counter that enforces the node cap.
 */
export function extractAxText(root: AxNode, maxNodes: number): AxExtractResult {
  const lines: string[] = [];
  const stack: AxNode[] = [root];
  let visited = 0;
  let truncated = false;
  while (stack.length > 0) {
    if (visited >= maxNodes) {
      truncated = true;
      break;
    }
    const node = stack.pop() as AxNode;
    visited += 1;
    if (node.offScreen === true) continue;
    if (node.role === SECURE_ROLE) continue;
    const text = nodeText(node);
    if (text.length > 0) lines.push(text);
    if (Array.isArray(node.children)) {
      // Push in reverse so children are visited in document order.
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
  return { text: lines.join("\n"), nodes: visited, truncated };
}
