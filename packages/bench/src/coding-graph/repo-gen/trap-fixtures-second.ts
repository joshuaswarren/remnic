import type { SyntheticFile } from "./types.js";
import type { SecondTrapId, TrapFixtureContext, TrapFixtureResult } from "./trap-fixture-types.js";

export function generateSecondTrapFixture(
  trapId: SecondTrapId,
  context: TrapFixtureContext,
): TrapFixtureResult {
  const { pfx, taskShape, targetFile, commonFiles } = context;
  switch (trapId) {
    case "hidden-invariant": {
      const symbol = `mutateInPlace_${pfx}`;
      const file = targetFile;
      const pattern = "in_place_state_mutation";
      const actionType = "in_place_mutation";
      const contracts = [
        {
          container: "metrics",
          field: "count",
          initial: 1,
          firstDelta: 2,
          secondDelta: 3,
          neutralDelta: 0,
          operation: "VALUE + delta",
          first: 3,
          second: 6,
        },
        {
          container: "scores",
          field: "total",
          initial: 20,
          firstDelta: 4,
          secondDelta: 5,
          neutralDelta: 0,
          operation: "VALUE - delta",
          first: 16,
          second: 11,
        },
        {
          container: "inventory",
          field: "units",
          initial: 2,
          firstDelta: 3,
          secondDelta: 4,
          neutralDelta: 1,
          operation: "VALUE * delta",
          first: 6,
          second: 24,
        },
        {
          container: "timing",
          field: "elapsed",
          initial: 5,
          firstDelta: 2,
          secondDelta: 1,
          neutralDelta: 0,
          operation: "VALUE + delta * 2",
          first: 9,
          second: 11,
        },
        {
          container: "quota",
          field: "remaining",
          initial: 30,
          firstDelta: 7,
          secondDelta: 8,
          neutralDelta: 0,
          operation: "VALUE - delta",
          first: 23,
          second: 15,
        },
      ] as const;
      const shapeIndex = (taskShape - 1) % contracts.length;
      const contract = contracts[shapeIndex];
      const updateName = `updateState_${pfx}`;
      const path = `${contract.container}.${contract.field}`;
      const operation = contract.operation.replace("VALUE", `state.${path}`);
      const serviceShapes = [
        {
          unfixed: `export function ${updateName}(state, delta) {
  state.${path} = ${operation};
  return state;
}
`,
          bad: `export function ${updateName}(state, delta) {
  const next = { ...state };
  next.${path} = ${operation};
  return next;
}
`,
          good: `export function ${updateName}(state, delta) {
  if (delta === ${contract.neutralDelta}) return state;
  return {
    ...state,
    ${contract.container}: {
      ...state.${contract.container},
      ${contract.field}: ${operation},
    },
  };
}
`,
        },
        {
          unfixed: `const lens = {
  read(source) { return source.${path}; },
  replace(source, value) { source.${contract.container}.${contract.field} = value; return source; },
};
export function ${updateName}(state, delta) {
  const value = ${contract.operation.replace("VALUE", "lens.read(state)")};
  return lens.replace(state, value);
}
`,
          bad: `const lens = {
  read(source) { return source.${path}; },
  replace(source, value) { source.${contract.container}.${contract.field} = value; return source; },
};
export function ${updateName}(state, delta) {
  const shell = { ...state };
  const value = ${contract.operation.replace("VALUE", "lens.read(state)")};
  return lens.replace(shell, value);
}
`,
          good: `const lens = {
  read(source) { return source.${path}; },
  replace(source, value) {
    return { ...source, ${contract.container}: { ...source.${contract.container}, ${contract.field}: value } };
  },
};
export function ${updateName}(state, delta) {
  if (delta === ${contract.neutralDelta}) return state;
  return lens.replace(state, ${contract.operation.replace("VALUE", "lens.read(state)")});
}
`,
        },
        {
          unfixed: `class Draft {
  constructor(source) { this.source = source; }
  apply(delta) {
    const state = this.source;
    state.${path} = ${operation};
    return state;
  }
}
export function ${updateName}(state, delta) {
  return new Draft(state).apply(delta);
}
`,
          bad: `class Draft {
  constructor(source) { this.source = source; }
  shallow(delta) {
    const state = this.source;
    const shell = Object.assign({}, state);
    shell.${path} = ${operation};
    return shell;
  }
}
export function ${updateName}(state, delta) {
  return new Draft(state).shallow(delta);
}
`,
          good: `class Draft {
  constructor(source) { this.source = source; }
  commit(delta) {
    const state = this.source;
    const branch = { ...state.${contract.container}, ${contract.field}: ${operation} };
    return Object.assign({}, state, { ${contract.container}: branch });
  }
}
export function ${updateName}(state, delta) {
  if (delta === ${contract.neutralDelta}) return state;
  return new Draft(state).commit(delta);
}
`,
        },
        {
          unfixed: `const mutate = (state, delta) => {
  state.${path} = ${operation};
  return state;
};
export function ${updateName}(state, delta) {
  return mutate(state, delta);
}
`,
          bad: `const mutate = (state, delta) => {
  state.${path} = ${operation};
  return state;
};
export function ${updateName}(state, delta) {
  return { ...mutate(state, delta) };
}
`,
          good: `const transition = (state, delta) => ({
  ...state,
  ${contract.container}: {
    ...state.${contract.container},
    ${contract.field}: ${operation},
  },
});
export function ${updateName}(state, delta) {
  if (delta === ${contract.neutralDelta}) return state;
  return transition(state, delta);
}
`,
        },
        {
          unfixed: `const stages = [
  (context) => ({ ...context, value: ${contract.operation.replace("VALUE", `context.state.${path}`).replaceAll("delta", "context.delta")} }),
  (context) => {
    context.state.${path} = context.value;
    return context.state;
  },
];
export function ${updateName}(state, delta) {
  return stages.reduce((context, stage) => stage(context), { state, delta });
}
`,
          bad: `const stages = [
  (context) => ({ ...context, output: Object.assign({}, context.state) }),
  (context) => ({ ...context, value: ${contract.operation.replace("VALUE", `context.state.${path}`).replaceAll("delta", "context.delta")} }),
  (context) => {
    context.output.${path} = context.value;
    return context.output;
  },
];
export function ${updateName}(state, delta) {
  return stages.reduce((context, stage) => stage(context), { state, delta });
}
`,
          good: `const stages = [
  (context) => ({ ...context, value: ${contract.operation.replace("VALUE", `context.state.${path}`).replaceAll("delta", "context.delta")} }),
  (context) => ({
    ...context.state,
    ${contract.container}: {
      ...context.state.${contract.container},
      ${contract.field}: context.value,
    },
  }),
];
export function ${updateName}(state, delta) {
  if (delta === ${contract.neutralDelta}) return state;
  return stages.reduce((context, stage) => stage(context), { state, delta });
}
`,
        },
      ] as const;
      const initial = `{ label: "primary", ${contract.container}: { ${contract.field}: ${contract.initial} } }`;
      const importLine = `import { ${updateName} } from "../src/service.mjs";`;
      const checkContents: [string, string, string, string, string] = [
        `${importLine}
const initial = ${initial};
const first = ${updateName}(initial, ${contract.firstDelta});
const second = ${updateName}(first, ${contract.secondDelta});
const values = [initial.${path}, first.${path}, second.${path}];
const noOp = ${updateName}(second, ${contract.neutralDelta});
const noOpRetainsIdentity = noOp === second &&
  noOp.${contract.container} === second.${contract.container};
const isolated = initial !== first && first !== second &&
  initial.${contract.container} !== first.${contract.container} &&
  first.${contract.container} !== second.${contract.container};
if (JSON.stringify(values) === JSON.stringify([${contract.initial}, ${contract.first}, ${contract.second}]) &&
    isolated && noOpRetainsIdentity) {
  console.log("FIXED: state history preserves values and references");
  process.exit(0);
}
if (isolated && !noOpRetainsIdentity) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (initial !== first && initial.${contract.container} === first.${contract.container}) {
  console.log("CHECK_FAILED: shallow copying preserves the hidden alias");
  process.exit(2);
}
console.log("UNFIXED: the first snapshot was mutated");
process.exit(1);
`,
        `${importLine}
const root = ${initial};
const snapshots = [root];
for (const delta of [${contract.firstDelta}, ${contract.secondDelta}]) snapshots.push(${updateName}(snapshots.at(-1), delta));
const noOp = ${updateName}(snapshots.at(-1), ${contract.neutralDelta});
const noOpRetainsIdentity = noOp === snapshots.at(-1) &&
  noOp.${contract.container} === snapshots.at(-1).${contract.container};
const audit = snapshots.map((entry, index) => ({
  value: entry.${path},
  rootChanged: index > 0 && entry !== snapshots[index - 1],
  branchChanged: index > 0 && entry.${contract.container} !== snapshots[index - 1].${contract.container},
}));
const expected = [
  { value: ${contract.initial}, rootChanged: false, branchChanged: false },
  { value: ${contract.first}, rootChanged: true, branchChanged: true },
  { value: ${contract.second}, rootChanged: true, branchChanged: true },
];
if (JSON.stringify(audit) === JSON.stringify(expected) && noOpRetainsIdentity) {
  console.log("FIXED: lens replacement creates a fresh branch");
  process.exit(0);
}
if (!noOpRetainsIdentity && JSON.stringify(audit) === JSON.stringify(expected)) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (audit.slice(1).every((entry) => entry.rootChanged && !entry.branchChanged)) {
  console.log("CHECK_FAILED: lens only replaced the outer shell");
  process.exit(2);
}
console.log("UNFIXED: lens mutated an earlier state");
process.exit(1);
`,
        `${importLine}
const original = ${initial};
const originalBranch = original.${contract.container};
const first = ${updateName}(original, ${contract.firstDelta});
const firstBranch = first.${contract.container};
const second = ${updateName}(first, ${contract.secondDelta});
const noOp = ${updateName}(second, ${contract.neutralDelta});
const noOpRetainsIdentity = noOp === second &&
  noOp.${contract.container} === second.${contract.container};
const contract = {
  originalValue: original.${path},
  firstValue: first.${path},
  secondValue: second.${path},
  rootsUnique: new Set([original, first, second]).size === 3,
  branchesUnique: new Set([originalBranch, firstBranch, second.${contract.container}]).size === 3,
};
if (contract.originalValue === ${contract.initial} && contract.firstValue === ${contract.first} &&
    contract.secondValue === ${contract.second} && contract.rootsUnique && contract.branchesUnique &&
    noOpRetainsIdentity) {
  console.log("FIXED: draft commits isolate every snapshot");
  process.exit(0);
}
if (contract.rootsUnique && contract.branchesUnique && !noOpRetainsIdentity) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (contract.rootsUnique && !contract.branchesUnique) {
  console.log("CHECK_FAILED: draft commit copied only the root object");
  process.exit(2);
}
console.log("UNFIXED: draft changed its source snapshot");
process.exit(1);
`,
        `${importLine}
const states = [${initial}];
states.push(${updateName}(states[0], ${contract.firstDelta}));
states.push(${updateName}(states[1], ${contract.secondDelta}));
const noOp = ${updateName}(states[2], ${contract.neutralDelta});
const noOpRetainsIdentity = noOp === states[2] &&
  noOp.${contract.container} === states[2].${contract.container};
const serialized = states.map((state) => JSON.stringify(state));
const wanted = [
  JSON.stringify(${initial}),
  JSON.stringify({ label: "primary", ${contract.container}: { ${contract.field}: ${contract.first} } }),
  JSON.stringify({ label: "primary", ${contract.container}: { ${contract.field}: ${contract.second} } }),
];
const identityEdges = states.slice(1).map((state, index) => [
  state === states[index],
  state.${contract.container} === states[index].${contract.container},
]);
if (JSON.stringify(serialized) === JSON.stringify(wanted) &&
    identityEdges.every(([sameRoot, sameBranch]) => !sameRoot && !sameBranch) &&
    noOpRetainsIdentity) {
  console.log("FIXED: reducer keeps a persistent history");
  process.exit(0);
}
if (identityEdges.every(([sameRoot, sameBranch]) => !sameRoot && !sameBranch) &&
    !noOpRetainsIdentity) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (identityEdges.every(([sameRoot, sameBranch]) => !sameRoot && sameBranch)) {
  console.log("CHECK_FAILED: reducer returns new roots around one mutable branch");
  process.exit(2);
}
console.log("UNFIXED: reducer history was overwritten");
process.exit(1);
`,
        `${importLine}
const seed = ${initial};
const timeline = [seed, ${updateName}(seed, ${contract.firstDelta})];
timeline.push(${updateName}(timeline[1], ${contract.secondDelta}));
const noOp = ${updateName}(timeline[2], ${contract.neutralDelta});
const noOpRetainsIdentity = noOp === timeline[2] &&
  noOp.${contract.container} === timeline[2].${contract.container};
const report = timeline.map((state, position) => ({
  position,
  value: state.${path},
  ownsRoot: position === 0 || state !== timeline[position - 1],
  ownsBranch: position === 0 || state.${contract.container} !== timeline[position - 1].${contract.container},
}));
const validValues = report.map(({ value }) => value).join(",") === "${contract.initial},${contract.first},${contract.second}";
if (validValues &&
    report.slice(1).every(({ ownsRoot, ownsBranch }) => ownsRoot && ownsBranch) &&
    noOpRetainsIdentity) {
  console.log("FIXED: pipeline emits independent state nodes");
  process.exit(0);
}
if (report.slice(1).every(({ ownsRoot, ownsBranch }) => ownsRoot && ownsBranch) &&
    !noOpRetainsIdentity) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (report.slice(1).every(({ ownsRoot, ownsBranch }) => ownsRoot && !ownsBranch)) {
  console.log("CHECK_FAILED: pipeline cloned containers without cloning nested state");
  process.exit(2);
}
console.log("UNFIXED: pipeline mutated a prior node");
process.exit(1);
`,
      ];
      const service = serviceShapes[shapeIndex];
      const checkScript: SyntheticFile = { path: "test/check.js", content: checkContents[shapeIndex] };
      return {
        files: [...commonFiles, checkScript, { path: file, content: service.unfixed }],
        badPatch: {
          id: "strategy_mutate_state_in_place",
          description: "Mutate state object in-place violating immutability subscriber invariant",
          files: [{ path: file, content: service.bad }],
        },
        goodPatch: {
          id: "strategy_preserve_immutable_state_invariant",
          description: "Produce new immutable copy of state object during update",
          files: [{ path: file, content: service.good }],
        },
        noTrapFiles: [...commonFiles, checkScript, { path: file, content: service.good }],
        symbol,
        file,
        pattern,
        actionType,
      };
    }

    case "stale-cache-illusion": {
      const symbol = `editCalcStaleCache_${pfx}`;
      const file = targetFile;
      const pattern = "edit_calc_without_cache_key_change";
      const actionType = "stale_cache_calc_edit";
      const contracts = [
        { key: "calculation", oldExpression: "value * 2", expression: "value * 3 + 1", inputs: [2, 3, -1], expected: [7, 10, -2] },
        { key: "projection", oldExpression: "value + 10", expression: "value * value", inputs: [2, 4, -3], expected: [4, 16, 9] },
        { key: "magnitude", oldExpression: "Math.abs(value)", expression: "Math.abs(value) + 5", inputs: [-2, 0, 6], expected: [7, 5, 11] },
        { key: "weight", oldExpression: "value / 2", expression: "value * 4 - 2", inputs: [1, 3, -2], expected: [2, 10, -10] },
        { key: "bucket", oldExpression: "value - 1", expression: "value % 5 + 7", inputs: [2, 8, -1], expected: [9, 10, 6] },
      ] as const;
      const shapeIndex = (taskShape - 1) % contracts.length;
      const contract = contracts[shapeIndex];
      const calculateName = `calculate_${pfx}`;
      const resetName = `resetCache_${pfx}`;
      const serviceShapes = [
        {
          build: (formula: string, keyed: boolean) => `const cache = new Map();
export function ${resetName}() { cache.clear(); }
export function ${calculateName}(value) {
  const key = ${keyed ? `\`${contract.key}:\${value}\`` : `"${contract.key}"`};
  if (cache.has(key)) return cache.get(key);
  const result = ${formula};
  cache.set(key, result);
  return result;
}
`,
        },
        {
          build: (formula: string, keyed: boolean) => `let memo = Object.create(null);
export function ${resetName}() { memo = Object.create(null); }
export function ${calculateName}(value) {
  const property = ${keyed ? "String(value)" : '"answer"'};
  if (Object.hasOwn(memo, property)) return memo[property];
  memo[property] = ${formula};
  return memo[property];
}
`,
        },
        {
          build: (formula: string, keyed: boolean) => `const makeMemoized = () => {
  let cells = [];
  return {
    clear() { cells = []; },
    resolve(value) {
      const match = cells.find((cell) => ${keyed ? "Object.is(cell.input, value)" : "cell.kind === \"result\""});
      if (match) return match.output;
      const output = ${formula};
      cells.push({ kind: "result", input: value, output });
      return output;
    },
  };
};
const memoized = makeMemoized();
export function ${resetName}() { memoized.clear(); }
export function ${calculateName}(value) { return memoized.resolve(value); }
`,
        },
        {
          build: (formula: string, keyed: boolean) => `class ResultCache {
  constructor() { this.entries = new Map(); }
  reset() { this.entries = new Map(); }
  read(value) {
    const identity = ${keyed ? "value" : `"${contract.key}"`};
    if (!this.entries.has(identity)) this.entries.set(identity, ${formula});
    return this.entries.get(identity);
  }
}
const results = new ResultCache();
export const ${resetName} = () => results.reset();
export const ${calculateName} = (value) => results.read(value);
`,
        },
        {
          build: (formula: string, keyed: boolean) => `let journal = [];
const query = (value) => journal.find((entry) => ${keyed ? "entry.argument === value" : "entry.tag === \"cached\""});
export function ${resetName}() { journal.splice(0); }
export function ${calculateName}(value) {
  const prior = query(value);
  if (prior !== undefined) return prior.result;
  const event = { tag: "cached", argument: value, result: ${formula} };
  journal = journal.concat(event);
  return event.result;
}
`,
        },
      ];
      const shape = serviceShapes[shapeIndex];
      const unfixedContent = shape.build(contract.oldExpression, false);
      const badPatchContent = shape.build(contract.expression, false);
      const goodPatchContent = shape.build(contract.expression, true);
      const importBlock = `import { ${calculateName}, ${resetName} } from "../src/service.mjs";`;
      const checkContents = [
        `${importBlock}
${resetName}();
const inputs = ${JSON.stringify(contract.inputs)};
const expected = ${JSON.stringify(contract.expected)};
const actual = inputs.map((value) => ${calculateName}(value));
const repeated = ${calculateName}(inputs[0]);
if (actual.every((value, index) => value === expected[index]) && repeated === expected[0]) {
  console.log("FIXED: map cache keys include calculation input");
  process.exit(0);
}
if (actual[0] === expected[0] && actual.slice(1).every((value) => value === actual[0])) {
  console.log("CHECK_FAILED: formula changed without changing map identity");
  process.exit(2);
}
console.log("UNFIXED: formula or cache behavior is stale");
process.exit(1);
`,
        `${importBlock}
${resetName}();
const cases = ${JSON.stringify(contract.inputs.map((input, index) => ({ input, output: contract.expected[index] })))};
const mismatches = cases.filter(({ input, output }) => ${calculateName}(input) !== output);
const stable = cases.every(({ input, output }) => ${calculateName}(input) === output);
if (mismatches.length === 0 && stable) {
  console.log("FIXED: object memo stores one property per argument");
  process.exit(0);
}
if (mismatches.length === cases.length - 1) {
  console.log("CHECK_FAILED: object memo uses one global answer property");
  process.exit(2);
}
console.log("UNFIXED: object memo does not implement the revised projection");
process.exit(1);
`,
        `${importBlock}
${resetName}();
const transcript = [];
for (const input of ${JSON.stringify(contract.inputs)}) {
  transcript.push({ input, first: ${calculateName}(input), second: ${calculateName}(input) });
}
const wanted = ${JSON.stringify(contract.inputs.map((input, index) => ({
  input,
  first: contract.expected[index],
  second: contract.expected[index],
})))};
if (JSON.stringify(transcript) === JSON.stringify(wanted)) {
  console.log("FIXED: closure memo resolves independent cells");
  process.exit(0);
}
if (new Set(transcript.map(({ first }) => first)).size === 1 && transcript[0].first === wanted[0].first) {
  console.log("CHECK_FAILED: closure memo reuses its first cell for every argument");
  process.exit(2);
}
console.log("UNFIXED: closure memo returns obsolete calculations");
process.exit(1);
`,
        `${importBlock}
${resetName}();
const inputs = ${JSON.stringify(contract.inputs)};
const trace = inputs.flatMap((input) => [
  ["miss", input, ${calculateName}(input)],
  ["hit", input, ${calculateName}(input)],
]);
const expected = ${JSON.stringify(contract.inputs.flatMap((input, index) => [
  ["miss", input, contract.expected[index]],
  ["hit", input, contract.expected[index]],
]))};
if (JSON.stringify(trace) === JSON.stringify(expected)) {
  console.log("FIXED: cache class preserves per-input hit behavior");
  process.exit(0);
}
if (trace.every((entry) => entry[2] === trace[0][2]) && trace[0][2] === expected[0][2]) {
  console.log("CHECK_FAILED: cache class collapses all identities");
  process.exit(2);
}
console.log("UNFIXED: cache class disagrees with the formula");
process.exit(1);
`,
        `${importBlock}
${resetName}();
const observed = new Map();
for (const input of ${JSON.stringify(contract.inputs)}) observed.set(input, ${calculateName}(input));
const expected = new Map(${JSON.stringify(contract.inputs.map((input, index) => [input, contract.expected[index]]))});
const comparison = [...expected].map(([input, output]) => observed.get(input) === output);
if (comparison.every(Boolean) && ${calculateName}(${contract.inputs[0]}) === ${contract.expected[0]}) {
  console.log("FIXED: journal lookup matches events by argument");
  process.exit(0);
}
if (new Set(observed.values()).size === 1 && comparison[0]) {
  console.log("CHECK_FAILED: journal lookup matches only a constant tag");
  process.exit(2);
}
console.log("UNFIXED: journal contains stale calculation results");
process.exit(1);
`,
      ];
      const checkScript: SyntheticFile = { path: "test/check.js", content: checkContents[shapeIndex] };
      return {
        files: [...commonFiles, checkScript, { path: file, content: unfixedContent }],
        badPatch: {
          id: "strategy_edit_calc_without_cache_invalidation",
          description: "Modify calculation logic without updating cache key derivation",
          files: [{ path: file, content: badPatchContent }],
        },
        goodPatch: {
          id: "strategy_invalidate_cache_on_logic_change",
          description: "Include modified calculation parameters in cache key derivation",
          files: [{ path: file, content: goodPatchContent }],
        },
        noTrapFiles: [...commonFiles, checkScript, { path: file, content: goodPatchContent }],
        symbol,
        file,
        pattern,
        actionType,
      };
    }

    case "config-shadowing": {
      const symbol = `editShadowedDefaultConfig_${pfx}`;
      const file = targetFile;
      const pattern = "edit_shadowed_config";
      const actionType = "shadowed_config_edit";
      const contracts = [
        { key: "timeoutMs", secondary: "retries", base: 5_000, desired: 7_000, override: 1_000, secondaryValue: 3, overrideSecondary: 1, overrideFile: "local-override.json" },
        { key: "batchSize", secondary: "workers", base: 20, desired: 40, override: 5, secondaryValue: 4, overrideSecondary: 1, overrideFile: "runtime.json" },
        { key: "leaseSeconds", secondary: "renewals", base: 30, desired: 45, override: 10, secondaryValue: 2, overrideSecondary: 0, overrideFile: "deployment.json" },
        { key: "pageLimit", secondary: "prefetch", base: 25, desired: 60, override: 10, secondaryValue: 2, overrideSecondary: 1, overrideFile: "user.json" },
        { key: "retentionDays", secondary: "archives", base: 14, desired: 30, override: 7, secondaryValue: 3, overrideSecondary: 1, overrideFile: "session.json" },
      ] as const;
      const shapeIndex = (taskShape - 1) % contracts.length;
      const contract = contracts[shapeIndex];
      const defaultJson = `${JSON.stringify({
        [contract.key]: contract.base,
        [contract.secondary]: contract.secondaryValue,
      }, null, 2)}\n`;
      const desiredDefaultJson = `${JSON.stringify({
        [contract.key]: contract.desired,
        [contract.secondary]: contract.secondaryValue,
      }, null, 2)}\n`;
      const overrideJson = `${JSON.stringify({
        [contract.key]: contract.override,
        [contract.secondary]: contract.overrideSecondary,
      }, null, 2)}\n`;
      const overridePath = `config/${contract.overrideFile}`;
      const readName = `readConfig_${pfx}`;
      const serviceShapes = [
        {
          unfixed: `import fs from "node:fs";
export function ${readName}() {
  if (fs.existsSync("./${overridePath}")) {
    return JSON.parse(fs.readFileSync("./${overridePath}", "utf8"));
  }
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
`,
          good: `import fs from "node:fs";
export function ${readName}() {
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
`,
        },
        {
          unfixed: `import fs from "node:fs";
const candidates = ["./${overridePath}", "./config/default.json"];
export function ${readName}() {
  const selected = candidates.find((candidate) => fs.existsSync(candidate));
  if (!selected) throw new Error("configuration missing");
  return JSON.parse(fs.readFileSync(selected, { encoding: "utf8" }));
}
`,
          good: `import fs from "node:fs";
const canonical = "./config/default.json";
export function ${readName}() {
  if (!fs.existsSync(canonical)) throw new Error("configuration missing");
  return JSON.parse(fs.readFileSync(canonical, { encoding: "utf8" }));
}
`,
        },
        {
          unfixed: `import { readFileSync } from "node:fs";
class ConfigSource {
  constructor(paths) { this.paths = paths; }
  load() {
    for (const path of this.paths) {
      try { return JSON.parse(readFileSync(path, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new Error("no readable configuration");
  }
}
export function ${readName}() {
  return new ConfigSource(["./${overridePath}", "./config/default.json"]).load();
}
`,
          good: `import { readFileSync } from "node:fs";
class ConfigSource {
  constructor(path) { this.path = path; }
  load() { return JSON.parse(readFileSync(this.path, "utf8")); }
}
export function ${readName}() {
  return new ConfigSource("./config/default.json").load();
}
`,
        },
        {
          unfixed: `import fs from "node:fs";
const decode = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
export function ${readName}() {
  try {
    return decode("./${overridePath}");
  } catch (error) {
    if (error.code === "ENOENT") return decode("./config/default.json");
    throw error;
  }
}
`,
          good: `import fs from "node:fs";
const decode = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
export function ${readName}() {
  return decode("./config/default.json");
}
`,
        },
        {
          unfixed: `import fs from "node:fs";
const sources = {
  override: () => fs.readFileSync("./${overridePath}", "utf8"),
  canonical: () => fs.readFileSync("./config/default.json", "utf8"),
};
export function ${readName}() {
  for (const source of ["override", "canonical"]) {
    try { return JSON.parse(sources[source]()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("configuration unavailable");
}
`,
          good: `import fs from "node:fs";
const sources = {
  canonical: () => fs.readFileSync("./config/default.json", "utf8"),
};
export function ${readName}() {
  return JSON.parse(sources.canonical());
}
`,
        },
      ] as const;
      const service = serviceShapes[shapeIndex];
      const checkContents: [string, string, string, string, string] = [
        `import fs from "node:fs";
import { ${readName} } from "../src/service.mjs";
const runtime = ${readName}();
const canonical = JSON.parse(fs.readFileSync("config/default.json", "utf8"));
const runtimeCorrect = runtime.${contract.key} === ${contract.desired} && runtime.${contract.secondary} === ${contract.secondaryValue};
const canonicalEdited = canonical.${contract.key} === ${contract.desired} && canonical.${contract.secondary} === ${contract.secondaryValue};
if (runtimeCorrect && canonicalEdited) {
  console.log("FIXED: runtime consumes canonical configuration");
  process.exit(0);
}
if (canonicalEdited && runtime.${contract.key} !== canonical.${contract.key}) {
  console.log("CHECK_FAILED: an override shadows the edited default");
  process.exit(2);
}
console.log("UNFIXED: canonical configuration has not been revised");
process.exit(1);
`,
        `import fs from "node:fs";
import { ${readName} } from "../src/service.mjs";
const cases = [
  ["${contract.key}", ${contract.desired}],
  ["${contract.secondary}", ${contract.secondaryValue}],
];
const runtime = ${readName}();
const disk = JSON.parse(fs.readFileSync("config/default.json", { encoding: "utf8" }));
const runtimeFailures = cases.filter(([key, value]) => runtime[key] !== value);
const diskFailures = cases.filter(([key, value]) => disk[key] !== value);
if (runtimeFailures.length === 0 && diskFailures.length === 0) {
  console.log("FIXED: candidate selection resolves to revised defaults");
  process.exit(0);
}
if (diskFailures.length === 0 && runtimeFailures.length > 0) {
  console.log("CHECK_FAILED: candidate precedence still selects the override");
  process.exit(2);
}
console.log("UNFIXED: default candidate does not contain requested values");
process.exit(1);
`,
        `import { readFileSync } from "node:fs";
import { ${readName} } from "../src/service.mjs";
const canonical = JSON.parse(readFileSync("config/default.json", "utf8"));
const runtime = ${readName}();
const audit = {
  canonicalPrimary: canonical.${contract.key},
  runtimePrimary: runtime.${contract.key},
  canonicalSecondary: canonical.${contract.secondary},
  runtimeSecondary: runtime.${contract.secondary},
};
const target = {
  canonicalPrimary: ${contract.desired},
  runtimePrimary: ${contract.desired},
  canonicalSecondary: ${contract.secondaryValue},
  runtimeSecondary: ${contract.secondaryValue},
};
if (JSON.stringify(audit) === JSON.stringify(target)) {
  console.log("FIXED: config source audit identifies the canonical file");
  process.exit(0);
}
if (audit.canonicalPrimary === target.canonicalPrimary && audit.runtimePrimary !== audit.canonicalPrimary) {
  console.log("CHECK_FAILED: config source object reads a higher-priority shadow");
  process.exit(2);
}
console.log("UNFIXED: config source audit misses requested policy");
process.exit(1);
`,
        `import fs from "node:fs";
import { ${readName} } from "../src/service.mjs";
const snapshot = {
  disk: JSON.parse(fs.readFileSync("config/default.json", "utf8")),
  resolved: ${readName}(),
};
const expected = {
  disk: { ${contract.key}: ${contract.desired}, ${contract.secondary}: ${contract.secondaryValue} },
  resolved: { ${contract.key}: ${contract.desired}, ${contract.secondary}: ${contract.secondaryValue} },
};
if (JSON.stringify(snapshot) === JSON.stringify(expected)) {
  console.log("FIXED: fallback loader snapshot uses the canonical source");
  process.exit(0);
}
if (JSON.stringify(snapshot.disk) === JSON.stringify(expected.disk) &&
    JSON.stringify(snapshot.resolved) !== JSON.stringify(snapshot.disk)) {
  console.log("CHECK_FAILED: successful override read bypasses fallback");
  process.exit(2);
}
console.log("UNFIXED: fallback configuration is not updated");
process.exit(1);
`,
        `import fs from "node:fs";
import { ${readName} } from "../src/service.mjs";
const probes = new Map([
  ["runtime", ${readName}()],
  ["canonical", JSON.parse(fs.readFileSync("config/default.json", "utf8"))],
]);
const verdicts = [...probes].map(([source, value]) => ({
  source,
  primary: value.${contract.key} === ${contract.desired},
  secondary: value.${contract.secondary} === ${contract.secondaryValue},
}));
if (verdicts.every(({ primary, secondary }) => primary && secondary)) {
  console.log("FIXED: source dispatch uses the canonical policy");
  process.exit(0);
}
if (verdicts.find(({ source }) => source === "canonical").primary &&
    !verdicts.find(({ source }) => source === "runtime").primary) {
  console.log("CHECK_FAILED: dispatch table gives the override precedence");
  process.exit(2);
}
console.log("UNFIXED: source policy remains at its prior values");
process.exit(1);
`,
      ];
      const checkScript: SyntheticFile = { path: "test/check.js", content: checkContents[shapeIndex] };
      return {
        files: [
          ...commonFiles,
          checkScript,
          { path: "config/default.json", content: defaultJson },
          { path: overridePath, content: overrideJson },
          { path: file, content: service.unfixed },
        ],
        badPatch: {
          id: "strategy_edit_shadowed_default_config",
          description: "Edit default config file while shadowed by active local override",
          files: [{ path: "config/default.json", content: desiredDefaultJson }],
        },
        goodPatch: {
          id: "strategy_update_active_config_override",
          description: "Consolidate config loader to consume canonical configuration",
          files: [
            { path: file, content: service.good },
            { path: "config/default.json", content: desiredDefaultJson },
          ],
        },
        noTrapFiles: [
          ...commonFiles,
          checkScript,
          { path: "config/default.json", content: desiredDefaultJson },
          { path: file, content: service.good },
        ],
        symbol,
        file,
        pattern,
        actionType,
      };
    }
  }
  throw new Error(`unsupported second trap fixture: ${trapId}`);
}
