import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #2513 load() of last_recall.json accepted arrays and proto keys.
// Keep the reject-array + unsafe-key skip in the load path.

export const LAST_RECALL_STATE_REL = path.join(
  "packages",
  "remnic-core",
  "src",
  "recall-state.ts",
);

export function findLastRecallLoadHoles(source) {
  const holes = [];
  const loadIdx = source.indexOf("async load(): Promise<void>");
  if (loadIdx < 0) {
    holes.push("LastRecallStore.load() is missing");
    return holes;
  }
  const loadBody = source.slice(loadIdx, loadIdx + 1200);
  if (!loadBody.includes("Array.isArray(parsed)")) {
    holes.push("load() must reject JSON arrays");
  }
  const skipsUnsafeKeys =
    loadBody.includes("isUnsafeStateKey") ||
    (loadBody.includes("__proto__") &&
      loadBody.includes("constructor") &&
      loadBody.includes("prototype"));
  if (!skipsUnsafeKeys) {
    holes.push("load() must skip unsafe session keys");
  }
  return holes;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(root, LAST_RECALL_STATE_REL), "utf8");
  const holes = findLastRecallLoadHoles(source);
  if (holes.length > 0) {
    console.error(
      ["last_recall.json load hardening regresssed (#2513):", ...holes.map((item) => `  - ${item}`)].join(
        "\n",
      ),
    );
    process.exit(1);
  }
}
