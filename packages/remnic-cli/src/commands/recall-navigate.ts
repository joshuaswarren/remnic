/**
 * `remnic recall expand|traverse` (issue #1956 CLI slice).
 *
 * Maps flags onto the pure core helpers. No orchestrator, no IO besides
 * the injected stdout/stderr. Budget 0 is off (tagged refusal).
 */
import {
  expandRecallNode,
  traverseRecallLink,
  type RecallNavNode,
} from "@remnic/core";

export interface RecallNavigateIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const RECALL_NAV_UNAVAILABLE_TAG = "[unavailable] budget_off";

export function recallNavigateHelp(): string {
  return `Usage: remnic recall <expand|traverse> --node <json> [--budget <n>] [--type <linkType>]

  expand    Re-render one node at the next disclosure level
  traverse  Follow typed links from a node

  --budget 0 turns navigation off and prints ${RECALL_NAV_UNAVAILABLE_TAG}
  --type    required for traverse: supports, contradicts, elaborates, supersedes, causes
`;
}

function takeFlag(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseBudget(rest: string[]): number {
  if (!rest.includes("--budget")) return 1;
  const raw = takeFlag(rest, "--budget");
  const budget = Number(raw);
  if (!Number.isFinite(budget)) {
    throw new Error(`--budget must be a number (got ${JSON.stringify(raw)})`);
  }
  return budget;
}

function parseNode(raw: string): RecallNavNode {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("--node must be JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--node must be a JSON object");
  }
  const node = value as Partial<RecallNavNode>;
  if (typeof node.id !== "string" || node.id.length === 0) {
    throw new Error("--node.id must be a non-empty string");
  }
  if (typeof node.disclosure !== "string") {
    throw new Error("--node.disclosure is required");
  }
  return node as RecallNavNode;
}

function emitUnavailable(io: RecallNavigateIo): number {
  io.stdout(RECALL_NAV_UNAVAILABLE_TAG);
  return 0;
}

/**
 * Flag mapper for `remnic recall`. Returns an exit code; does not touch
 * `process.exitCode` so tests can call it without a process-global leak.
 */
export function runRecallNavigate(rest: string[], io: RecallNavigateIo): number {
  const action = rest[0];
  if (
    rest.length === 0 ||
    action === "--help" ||
    action === "-h" ||
    action === "help"
  ) {
    io.stdout(recallNavigateHelp());
    return 0;
  }
  try {
    const budget = parseBudget(rest);
    const nodeRaw = takeFlag(rest, "--node");
    if (nodeRaw === undefined) throw new Error("--node is required");
    const node = parseNode(nodeRaw);
    if (action === "expand") {
      const result = expandRecallNode(node, { budget });
      if (result.status === "unavailable") return emitUnavailable(io);
      io.stdout(JSON.stringify(result));
      return 0;
    }
    if (action === "traverse") {
      const linkType = takeFlag(rest, "--type");
      if (linkType === undefined) throw new Error("traverse requires --type");
      const result = traverseRecallLink(node, linkType, { budget });
      if (result.status === "unavailable") return emitUnavailable(io);
      io.stdout(JSON.stringify(result));
      return 0;
    }
    io.stderr(`recall: unknown action "${action}".`);
    io.stderr(recallNavigateHelp());
    return 1;
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runRecallNavigateCommand(rest: string[]): Promise<void> {
  const code = runRecallNavigate(rest, {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  if (code !== 0) process.exitCode = code;
}
