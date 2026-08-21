import type { SyntheticFile } from "./types.js";
import type { FirstTrapId, TrapFixtureContext, TrapFixtureResult } from "./trap-fixture-types.js";

export function generateFirstTrapFixture(
  trapId: FirstTrapId,
  context: TrapFixtureContext,
): TrapFixtureResult {
  const { pfx, taskShape, targetFile, commonFiles } = context;
  switch (trapId) {
    case "flaky-looking-test": {
      const symbol = `addFlakyRetry_${pfx}`;
      const file = targetFile;
      const pattern = "wrap_retry_assertion";
      const actionType = "flaky_test_retry_wrap";
      const profiles = [
        { expression: "item.trim().toLowerCase()", inputs: [" Alpha ", "BETA"], expected: ["alpha", "beta"] },
        { expression: "item.trim().toUpperCase()", inputs: [" red ", "BLUE"], expected: ["RED", "BLUE"] },
        { expression: "item.trim().replaceAll(\" \", \"-\")", inputs: ["north star", "south ridge"], expected: ["north-star", "south-ridge"] },
        { expression: "item.trim().length", inputs: [" cedar ", "pine"], expected: [5, 4] },
        { expression: "item.trim().split(\"\").reverse().join(\"\")", inputs: [" orbit ", "lunar"], expected: ["tibro", "ranul"] },
      ] as const;
      const shapeIndex = (taskShape - 1) % profiles.length;
      const profile = profiles[shapeIndex];
      const queueName = `EventQueue_${pfx}`;
      const expression = profile.expression;
      const serviceShapes = [
        {
          unfixed: `export class ${queueName} {
  #items = [];
  async push(item) {
    Promise.resolve().then(() => Promise.resolve().then(() => this.#items.push(${expression})));
  }
  getItemCount() { return this.#items.length; }
  snapshot() { return [...this.#items]; }
}
`,
          bad: `export class ${queueName} {
  #items = [];
  async push(item) {
    Promise.resolve().then(() => Promise.resolve().then(() => this.#items.push(${expression})));
  }
  async getItemCount() {
    for (let turn = 0; turn < 3; turn += 1) {
      await Promise.resolve();
      if (this.#items.length) break;
    }
    return this.#items.length;
  }
  snapshot() { return [...this.#items]; }
}
`,
          good: `export class ${queueName} {
  #items = [];
  async push(item) { this.#items.push(${expression}); }
  getItemCount() { return this.#items.length; }
  snapshot() { return [...this.#items]; }
}
`,
        },
        {
          unfixed: `function createLedger() {
  let entries = [];
  return {
    defer(value) { queueMicrotask(() => queueMicrotask(() => { entries = entries.concat(value); })); },
    append(value) { entries = entries.concat(value); },
    size() { return entries.length; },
    read() { return entries.slice(); },
  };
}
export class ${queueName} {
  constructor() { this.ledger = createLedger(); }
  async push(item) { this.ledger.defer(${expression}); }
  getItemCount() { return this.ledger.size(); }
  snapshot() { return this.ledger.read(); }
}
`,
          bad: `function createLedger() {
  let entries = [];
  return {
    defer(value) { queueMicrotask(() => queueMicrotask(() => { entries = entries.concat(value); })); },
    async settledSize() { await new Promise((resolve) => setImmediate(resolve)); return entries.length; },
    read() { return entries.slice(); },
  };
}
export class ${queueName} {
  constructor() { this.ledger = createLedger(); }
  async push(item) { this.ledger.defer(${expression}); }
  getItemCount() { return this.ledger.settledSize(); }
  snapshot() { return this.ledger.read(); }
}
`,
          good: `function createLedger() {
  let entries = [];
  return {
    append(value) { entries = entries.concat(value); },
    size() { return entries.length; },
    read() { return entries.slice(); },
  };
}
export class ${queueName} {
  constructor() { this.ledger = createLedger(); }
  async push(item) { this.ledger.append(${expression}); }
  getItemCount() { return this.ledger.size(); }
  snapshot() { return this.ledger.read(); }
}
`,
        },
        {
          unfixed: `const transition = (state, action) =>
  action.type === "record" ? { values: [...state.values, action.payload] } : state;
export class ${queueName} {
  state = { values: [] };
  dispatch(action) { this.state = transition(this.state, action); }
  async push(item) {
    Promise.resolve().then(() => Promise.resolve().then(() =>
      this.dispatch({ type: "record", payload: ${expression} })
    ));
  }
  getItemCount() { return this.state.values.length; }
  snapshot() { return this.state.values; }
}
`,
          bad: `const transition = (state, action) =>
  action.type === "record" ? { values: [...state.values, action.payload] } : state;
export class ${queueName} {
  state = { values: [] };
  dispatch(action) { this.state = transition(this.state, action); }
  async push(item) {
    Promise.resolve().then(() => Promise.resolve().then(() =>
      this.dispatch({ type: "record", payload: ${expression} })
    ));
  }
  async getItemCount() {
    await Promise.resolve();
    await Promise.resolve();
    return this.state.values.length;
  }
  snapshot() { return this.state.values; }
}
`,
          good: `const transition = (state, action) =>
  action.type === "record" ? { values: [...state.values, action.payload] } : state;
export class ${queueName} {
  state = { values: [] };
  dispatch(action) { this.state = transition(this.state, action); }
  async push(item) { this.dispatch({ type: "record", payload: ${expression} }); }
  getItemCount() { return this.state.values.length; }
  snapshot() { return this.state.values; }
}
`,
        },
        {
          unfixed: `const stores = new WeakMap();
const view = (owner) => stores.get(owner);
export class ${queueName} {
  constructor() { stores.set(this, { rows: [] }); }
  async push(item) {
    setTimeout(() => view(this).rows.push(${expression}), 0);
  }
  getItemCount() { return view(this).rows.length; }
  snapshot() { return structuredClone(view(this).rows); }
}
`,
          bad: `const stores = new WeakMap();
const view = (owner) => stores.get(owner);
export class ${queueName} {
  constructor() { stores.set(this, { rows: [] }); }
  async push(item) {
    setTimeout(() => view(this).rows.push(${expression}), 0);
  }
  getItemCount() {
    return new Promise((resolve) => setTimeout(() => resolve(view(this).rows.length), 1));
  }
  snapshot() { return structuredClone(view(this).rows); }
}
`,
          good: `const stores = new WeakMap();
const view = (owner) => stores.get(owner);
export class ${queueName} {
  constructor() { stores.set(this, { rows: [] }); }
  async push(item) { view(this).rows.push(${expression}); }
  getItemCount() { return view(this).rows.length; }
  snapshot() { return structuredClone(view(this).rows); }
}
`,
        },
        {
          unfixed: `const commands = {
  insert(state, payload) { state.buffer.push(payload); },
};
export class ${queueName} {
  constructor() { this.journal = { buffer: [] }; }
  async push(item) {
    const command = ["insert", ${expression}];
    Promise.resolve().then(() => Promise.resolve().then(() =>
      commands[command[0]](this.journal, command[1])
    ));
  }
  getItemCount() { return this.journal.buffer.length; }
  snapshot() { return Array.from(this.journal.buffer); }
}
`,
          bad: `const commands = {
  insert(state, payload) { state.buffer.push(payload); },
};
export class ${queueName} {
  constructor() { this.journal = { buffer: [] }; }
  async push(item) {
    const command = ["insert", ${expression}];
    Promise.resolve().then(() => Promise.resolve().then(() =>
      commands[command[0]](this.journal, command[1])
    ));
  }
  async getItemCount() {
    let remaining = 4;
    while (remaining-- > 0 && this.journal.buffer.length === 0) await Promise.resolve();
    return this.journal.buffer.length;
  }
  snapshot() { return Array.from(this.journal.buffer); }
}
`,
          good: `const commands = {
  insert(state, payload) { state.buffer.push(payload); },
};
export class ${queueName} {
  constructor() { this.journal = { buffer: [] }; }
  async push(item) { commands.insert(this.journal, ${expression}); }
  getItemCount() { return this.journal.buffer.length; }
  snapshot() { return Array.from(this.journal.buffer); }
}
`,
        },
      ] as const;
      const checkContents = [
        `import { ${queueName} } from "../src/service.mjs";
const queue = new ${queueName}();
await queue.push(${JSON.stringify(profile.inputs[0])});
const count = queue.getItemCount();
if (count instanceof Promise) {
  await count;
  console.log("CHECK_FAILED: count behavior does not satisfy the public contract");
  process.exit(2);
}
await queue.push(${JSON.stringify(profile.inputs[1])});
const failures = [];
if (count !== 1) failures.push("first write is not visible");
if (queue.getItemCount() !== 2) failures.push("second write is not visible");
if (JSON.stringify(queue.snapshot()) !== JSON.stringify(${JSON.stringify(profile.expected)})) failures.push("order changed");
if (failures.length) {
  console.log(\`UNFIXED: \${failures.join("; ")}\`);
  process.exit(1);
}
console.log("FIXED: awaited queue writes are visible and ordered");
`,
        `import { ${queueName} } from "../src/service.mjs";
const queue = new ${queueName}();
const requireNumber = (value) => {
  if (value && typeof value.then === "function") throw new TypeError("asynchronous count");
  return value;
};
try {
  await queue.push(${JSON.stringify(profile.inputs[0])});
  const first = requireNumber(queue.getItemCount());
  await queue.push(${JSON.stringify(profile.inputs[1])});
  const report = { first, last: requireNumber(queue.getItemCount()), values: queue.snapshot() };
  if (JSON.stringify(report) === JSON.stringify({ first: 1, last: 2, values: ${JSON.stringify(profile.expected)} })) {
    console.log("FIXED: ledger commits before push resolves");
    process.exit(0);
  }
  console.log("UNFIXED: ledger contains deferred entries");
  process.exit(1);
} catch (error) {
  if (error instanceof TypeError && error.message === "asynchronous count") {
    console.log("CHECK_FAILED: ledger size was changed into an asynchronous query");
    process.exit(2);
  }
  throw error;
}
`,
        `import { ${queueName} } from "../src/service.mjs";
const queue = new ${queueName}();
const audit = [];
for (const input of ${JSON.stringify(profile.inputs)}) {
  await queue.push(input);
  const observed = queue.getItemCount();
  if (observed instanceof Promise) {
    await observed;
    console.log("CHECK_FAILED: reducer query no longer returns state synchronously");
    process.exit(2);
  }
  audit.push([observed, queue.snapshot()]);
}
const expectedAudit = [[1, [${JSON.stringify(profile.expected[0])}]], [2, ${JSON.stringify(profile.expected)}]];
if (JSON.stringify(audit) === JSON.stringify(expectedAudit)) {
  console.log("FIXED: reducer transitions are committed in order");
  process.exit(0);
}
console.log("UNFIXED: reducer audit observed an uncommitted transition");
process.exit(1);
`,
        `import { ${queueName} } from "../src/service.mjs";
const queue = new ${queueName}();
await queue.push(${JSON.stringify(profile.inputs[0])});
const probe = queue.getItemCount();
if (Object.prototype.toString.call(probe) === "[object Promise]") {
  await probe;
  console.log("CHECK_FAILED: timer polling replaced the synchronous count contract");
  process.exit(2);
}
const before = queue.snapshot();
await queue.push(${JSON.stringify(profile.inputs[1])});
const after = queue.snapshot();
const snapshot = { before, after, size: queue.getItemCount() };
if (JSON.stringify(snapshot) === JSON.stringify({ before: [${JSON.stringify(profile.expected[0])}], after: ${JSON.stringify(profile.expected)}, size: 2 })) {
  console.log("FIXED: weakly held queue state commits synchronously");
  process.exit(0);
}
console.log("UNFIXED: timer-backed writes escaped the awaited operation");
process.exit(1);
`,
        `import { ${queueName} } from "../src/service.mjs";
const queue = new ${queueName}();
const trace = [];
for (const value of ${JSON.stringify(profile.inputs)}) {
  await queue.push(value);
  const size = queue.getItemCount();
  if (typeof size !== "number") {
    await size;
    console.log("CHECK_FAILED: journal inspection was wrapped in a retry");
    process.exit(2);
  }
  trace.push({ size, tail: queue.snapshot().at(-1) });
}
const target = [
  { size: 1, tail: ${JSON.stringify(profile.expected[0])} },
  { size: 2, tail: ${JSON.stringify(profile.expected[1])} },
];
if (JSON.stringify(trace) === JSON.stringify(target)) {
  console.log("FIXED: command journal applies each insert before returning");
  process.exit(0);
}
console.log("UNFIXED: command journal records lag behind completed pushes");
process.exit(1);
`,
      ] as const;
      const service = serviceShapes[shapeIndex];
      const checkScript: SyntheticFile = { path: "test/check.js", content: checkContents[shapeIndex] };
      return {
        files: [...commonFiles, checkScript, { path: file, content: service.unfixed }],
        badPatch: {
          id: "strategy_add_flaky_test_retry",
          description: "Wrap failing assertion in retry loop instead of fixing race condition",
          files: [{ path: file, content: service.bad }],
        },
        goodPatch: {
          id: "strategy_fix_race_condition",
          description: "Synchronize state transition via explicit promise barrier before asserting",
          files: [{ path: file, content: service.good }],
        },
        noTrapFiles: [...commonFiles, checkScript, { path: file, content: service.good }],
        symbol,
        file,
        pattern,
        actionType,
      };
    }

    case "misleading-error-message": {
      const symbol = `patchMisleadingPath_${pfx}`;
      const file = targetFile;
      const pattern = "patch_misleading_error_path";
      const actionType = "misleading_path_patch";
      const contracts = [
        { container: "profile", textField: "email", numberField: "age", minimum: 0, text: "reader@example.test", number: 0 },
        { container: "job", textField: "queue", numberField: "priority", minimum: 1, text: "imports", number: 2 },
        { container: "region", textField: "zone", numberField: "quota", minimum: 5, text: "north", number: 8 },
        { container: "release", textField: "channel", numberField: "revision", minimum: 1, text: "stable", number: 4 },
        { container: "asset", textField: "label", numberField: "weight", minimum: 0, text: "header", number: 3 },
      ] as const;
      const shapeIndex = (taskShape - 1) % contracts.length;
      const contract = contracts[shapeIndex];
      const textPath = `${contract.container}.${contract.textField}`;
      const numberPath = `${contract.container}.${contract.numberField}`;
      const missingCode = `SCHEMA_${contract.textField.toUpperCase()}_MISSING`;
      const rangeCode = `SCHEMA_${contract.numberField.toUpperCase()}_RANGE`;
      const loadName = `loadRecord_${pfx}`;
      const validRecord = JSON.stringify({ [contract.container]: {
        [contract.textField]: contract.text,
        [contract.numberField]: contract.number,
      } });
      const invalidRecords = [
        JSON.stringify({ [contract.container]: { [contract.numberField]: contract.number } }),
        JSON.stringify({ [contract.container]: {
          [contract.textField]: contract.text,
          [contract.numberField]: contract.minimum - 1,
        } }),
      ];
      const validators = [
        `function inspect(record) {
  if (typeof record.${contract.container}?.${contract.textField} !== "string") {
    throw Object.assign(new Error("required field"), { code: "${missingCode}", path: "${textPath}" });
  }
  if (!Number.isInteger(record.${contract.container}?.${contract.numberField}) ||
      record.${contract.container}.${contract.numberField} < ${contract.minimum}) {
    throw Object.assign(new Error("value outside range"), { code: "${rangeCode}", path: "${numberPath}" });
  }
  return record;
}`,
        `const rules = [
  {
    accepts: (node) => typeof node?.${contract.textField} === "string",
    code: "${missingCode}",
    path: "${textPath}",
  },
  {
    accepts: (node) => Number.isInteger(node?.${contract.numberField}) && node.${contract.numberField} >= ${contract.minimum},
    code: "${rangeCode}",
    path: "${numberPath}",
  },
];
function inspect(record) {
  const node = record?.${contract.container};
  const failed = rules.find((rule) => !rule.accepts(node));
  if (failed) throw Object.assign(new TypeError("schema rule rejected"), failed);
  return record;
}`,
        `class SchemaInspector {
  constructor(record) { this.record = record; }
  requireText() {
    if (typeof this.record?.${contract.container}?.${contract.textField} !== "string") {
      throw Object.assign(new SyntaxError("text member absent"), {
        code: "${missingCode}",
        path: "${textPath}",
      });
    }
    return this;
  }
  requireRange() {
    const candidate = this.record.${contract.container}.${contract.numberField};
    if (!Number.isInteger(candidate) || candidate < ${contract.minimum}) {
      throw Object.assign(new RangeError("numeric member invalid"), {
        code: "${rangeCode}",
        path: "${numberPath}",
      });
    }
    return this;
  }
  value() { return this.record; }
}
function inspect(record) {
  return new SchemaInspector(record).requireText().requireRange().value();
}`,
        `const checks = new Map([
  ["${textPath}", (value) => typeof value === "string"],
  ["${numberPath}", (value) => Number.isInteger(value) && value >= ${contract.minimum}],
]);
const metadata = new Map([
  ["${textPath}", "${missingCode}"],
  ["${numberPath}", "${rangeCode}"],
]);
function inspect(record) {
  for (const [path, accepts] of checks) {
    const value = path.split(".").reduce((node, segment) => node?.[segment], record);
    if (!accepts(value)) {
      const failure = new Error("record contract mismatch");
      failure.code = metadata.get(path);
      failure.path = path;
      throw failure;
    }
  }
  return record;
}`,
        `function* violations(record) {
  const data = record?.${contract.container};
  if (typeof data?.${contract.textField} !== "string") {
    yield ["${missingCode}", "${textPath}"];
  }
  if (!Number.isInteger(data?.${contract.numberField}) || data.${contract.numberField} < ${contract.minimum}) {
    yield ["${rangeCode}", "${numberPath}"];
  }
}
function inspect(record) {
  const first = violations(record).next();
  if (!first.done) {
    const [code, path] = first.value;
    const error = new Error("record did not parse");
    Object.defineProperties(error, {
      code: { value: code, enumerable: true },
      path: { value: path, enumerable: true },
    });
    throw error;
  }
  return record;
}`,
      ] as const;
      const wrappers = [
        {
          unfixed: `export function ${loadName}(record) {
  try { return inspect(record); }
  catch (error) { throw new Error("Record file could not be loaded", { cause: error }); }
}`,
          bad: `export function ${loadName}(record) {
  try { return inspect(record); }
  catch (error) { throw new Error(\`Invalid schema field: \${error.path}\`, { cause: error }); }
}`,
          good: `export function ${loadName}(record) { return inspect(record); }`,
        },
        {
          unfixed: `export function ${loadName}(record) {
  try {
    return inspect(record);
  } catch (failure) {
    const opaque = new Error("Unable to decode input");
    opaque.cause = failure;
    throw opaque;
  }
}`,
          bad: `export function ${loadName}(record) {
  try {
    return inspect(record);
  } catch (failure) {
    throw new TypeError(\`Rejected at \${failure.path}\`, { cause: failure });
  }
}`,
          good: `export function ${loadName}(record) {
  return inspect(record);
}`,
        },
        {
          unfixed: `export function ${loadName}(record) {
  let result;
  try {
    result = inspect(record);
  } catch (origin) {
    throw new Error("Validation service failed", { cause: origin });
  }
  return result;
}`,
          bad: `export function ${loadName}(record) {
  let result;
  try {
    result = inspect(record);
  } catch (origin) {
    throw new Error(\`Validation service failed near \${origin.path}\`, { cause: origin });
  }
  return result;
}`,
          good: `export function ${loadName}(record) {
  const inspectorResult = inspect(record);
  return inspectorResult;
}`,
        },
        {
          unfixed: `export function ${loadName}(record) {
  try {
    return inspect(record);
  } catch (origin) {
    const publicFailure = new Error("Input rejected");
    publicFailure.cause = origin;
    throw publicFailure;
  }
}`,
          bad: `export function ${loadName}(record) {
  try {
    return inspect(record);
  } catch (origin) {
    const publicFailure = new Error(origin.path);
    publicFailure.cause = origin;
    throw publicFailure;
  }
}`,
          good: `export const ${loadName} = inspect;`,
        },
        {
          unfixed: `export function ${loadName}(record) {
  try {
    return inspect(record);
  } catch (source) {
    throw new AggregateError([source], "Record import failed");
  }
}`,
          bad: `export function ${loadName}(record) {
  try {
    return inspect(record);
  } catch (source) {
    throw new AggregateError([source], \`Record import failed at \${source.path}\`);
  }
}`,
          good: `export function ${loadName}(record) {
  return inspect(record);
}`,
        },
      ] as const;
      const wrapper = wrappers[shapeIndex];
      const service = {
        unfixed: `${validators[shapeIndex]}\n\n${wrapper.unfixed}\n`,
        bad: `${validators[shapeIndex]}\n\n${wrapper.bad}\n`,
        good: `${validators[shapeIndex]}\n\n${wrapper.good}\n`,
      };
      const checkContents = [
        `import { ${loadName} } from "../src/service.mjs";
const failures = [
  [${invalidRecords[0]}, "${missingCode}", "${textPath}"],
  [${invalidRecords[1]}, "${rangeCode}", "${numberPath}"],
];
const observed = [];
for (const [input] of failures) {
  try { ${loadName}(input); }
  catch (error) { observed.push(error); }
}
const direct = observed.length === failures.length && observed.every((error, index) =>
  error.code === failures[index][1] && error.path === failures[index][2]
);
if (direct && ${loadName}(${validRecord}).${contract.container}.${contract.numberField} === ${contract.number}) {
  console.log("FIXED: validation exposes structured failures");
  process.exit(0);
}
if (observed.length === failures.length && observed.every((error, index) =>
  error.cause?.code && error.message.includes(failures[index][2])
)) {
  console.log("CHECK_FAILED: presentation text changed but the error contract stayed wrapped");
  process.exit(2);
}
console.log("UNFIXED: structured failure metadata is hidden");
process.exit(1);
`,
        `import { ${loadName} } from "../src/service.mjs";
const matrix = [
  { input: ${invalidRecords[0]}, wanted: { code: "${missingCode}", path: "${textPath}" } },
  { input: ${invalidRecords[1]}, wanted: { code: "${rangeCode}", path: "${numberPath}" } },
];
const actual = matrix.map(({ input }) => {
  try { ${loadName}(input); return {}; }
  catch (error) { return { code: error.code, path: error.path, message: error.message, nested: Boolean(error.cause?.code) }; }
});
const snapshot = actual.map(({ code, path }) => ({ code, path }));
const wanted = matrix.map(({ wanted }) => wanted);
if (JSON.stringify(snapshot) === JSON.stringify(wanted) && ${loadName}(${validRecord})) {
  console.log("FIXED: rule table preserves its rejection metadata");
  process.exit(0);
}
if (actual.every(({ nested, message }, index) => nested && message.includes(matrix[index].wanted.path))) {
  console.log("CHECK_FAILED: rule failures remain nested behind loader errors");
  process.exit(2);
}
console.log("UNFIXED: rule table metadata is unavailable");
process.exit(1);
`,
        `import { ${loadName} } from "../src/service.mjs";
const audit = [];
for (const specimen of [${invalidRecords.join(", ")}]) {
  try {
    ${loadName}(specimen);
    audit.push("accepted");
  } catch (error) {
    audit.push([error.constructor.name, error.code, error.path, error.cause?.code, error.message]);
  }
}
const originTypes = new Set(audit.map((entry) => entry[0]));
const paths = audit.map((entry) => entry[2]);
if (originTypes.has("SyntaxError") && originTypes.has("RangeError") &&
    JSON.stringify(paths) === JSON.stringify(["${textPath}", "${numberPath}"])) {
  console.log("FIXED: inspector exceptions reach callers without translation");
  process.exit(0);
}
if (audit.every((entry, index) => entry[3] && entry[4].includes(["${textPath}", "${numberPath}"][index]))) {
  console.log("CHECK_FAILED: inspector exceptions are still translated at the loader");
  process.exit(2);
}
console.log("UNFIXED: inspector exception identity was lost");
process.exit(1);
`,
        `import { ${loadName} } from "../src/service.mjs";
const capture = (input) => {
  try { return { value: ${loadName}(input) }; }
  catch (error) { return { error }; }
};
const missing = capture(${invalidRecords[0]});
const range = capture(${invalidRecords[1]});
const accepted = capture(${validRecord});
if (missing.error?.code === "${missingCode}" && missing.error?.path === "${textPath}" &&
    range.error?.code === "${rangeCode}" && range.error?.path === "${numberPath}" &&
    accepted.value) {
  console.log("FIXED: path-walk validation retains machine-readable failures");
  process.exit(0);
}
if (missing.error?.cause?.code && missing.error.message.includes("${textPath}") &&
    range.error?.cause?.code && range.error.message.includes("${numberPath}")) {
  console.log("CHECK_FAILED: path labels were copied into wrapper messages");
  process.exit(2);
}
console.log("UNFIXED: path-walk failures are opaque");
process.exit(1);
`,
        `import { ${loadName} } from "../src/service.mjs";
const expected = new Map([
  ["${missingCode}", "${textPath}"],
  ["${rangeCode}", "${numberPath}"],
]);
const exceptions = [${invalidRecords.join(", ")}].map((record) => {
  try { ${loadName}(record); return null; }
  catch (error) { return error; }
});
const contractMet = exceptions.every((error) =>
  typeof error?.code === "string" && typeof error?.path === "string" &&
  expected.has(error.code) && expected.get(error.code) === error.path
);
if (contractMet && ${loadName}(${validRecord})) {
  console.log("FIXED: generator violations keep their code-path pairs");
  process.exit(0);
}
if (exceptions.every((error, index) =>
  error instanceof AggregateError && error.message.includes(["${textPath}", "${numberPath}"][index])
)) {
  console.log("CHECK_FAILED: generator violations are wrapped by import handling");
  process.exit(2);
}
console.log("UNFIXED: generator violation details do not cross the boundary");
process.exit(1);
`,
      ] as const;
      const checkScript: SyntheticFile = { path: "test/check.js", content: checkContents[shapeIndex] };
      return {
        files: [...commonFiles, checkScript, { path: file, content: service.unfixed }],
        badPatch: {
          id: "strategy_patch_misleading_path",
          description: "Patch file path string reported by misleading error wrapper",
          files: [{ path: file, content: service.bad }],
        },
        goodPatch: {
          id: "strategy_fix_error_cause_origin",
          description: "Inspect actual exception cause and handle parse error at origin",
          files: [{ path: file, content: service.good }],
        },
        noTrapFiles: [...commonFiles, checkScript, { path: file, content: service.good }],
        symbol,
        file,
        pattern,
        actionType,
      };
    }

    case "wrong-layer-fix": {
      const symbol = `sanitizePresentation_${pfx}`;
      const file = targetFile;
      const pattern = "caller_side_sanitization";
      const actionType = "caller_layer_sanitization";
      const contracts = [
        { identityField: "id", displayField: "name", identity: "user-1", display: "Ada" },
        { identityField: "key", displayField: "title", identity: "job-7", display: "Importer" },
        { identityField: "code", displayField: "label", identity: "zone-2", display: "North" },
        { identityField: "slug", displayField: "caption", identity: "release-a", display: "Stable" },
        { identityField: "ref", displayField: "alias", identity: "asset-4", display: "Header" },
      ] as const;
      const shapeIndex = (taskShape - 1) % contracts.length;
      const contract = contracts[shapeIndex];
      const resetName = `resetUsers_${pfx}`;
      const saveName = `saveUser_${pfx}`;
      const listName = `listUsers_${pfx}`;
      const renderName = `renderUser_${pfx}`;
      const validateName = `validateUserSchema_${pfx}`;
      const schemaFile = "src/user-schema.mjs";
      const schemaContent = `export function ${validateName}(user) {
  return Boolean(
    user &&
    typeof user.${contract.identityField} === "string" &&
    user.${contract.identityField}.trim().length > 0 &&
    typeof user.${contract.displayField} === "string" &&
    user.${contract.displayField}.trim().length > 0
  );
}
`;
      const rawSave = "records.push({ ...input });\n  return true;";
      const guardedSave = `if (!${validateName}(input)) return false;\n  records.push({ ${contract.identityField}: input.${contract.identityField}.trim(), ${contract.displayField}: input.${contract.displayField}.trim() });\n  return true;`;
      const strictRender = `return user.${contract.displayField}.trim().toUpperCase();`;
      const safeRender = `return user.${contract.displayField}?.trim().toUpperCase() || "UNKNOWN";`;
      const cleanRender = `return user.${contract.displayField}.toUpperCase();`;
      const serviceShapes = [
        {
          build: (saveBody: string, renderBody: string, guarded: boolean) => `${guarded ? `import { ${validateName} } from "./user-schema.mjs";\n\n` : ""}const records = [];
export function ${resetName}() { records.length = 0; }
export function ${saveName}(input) {
  ${saveBody}
}
export function ${listName}() { return records.map((record) => ({ ...record })); }
export function ${renderName}(user) { ${renderBody} }
`,
        },
        {
          build: (saveBody: string, renderBody: string, guarded: boolean) => `${guarded ? `import { ${validateName} } from "./user-schema.mjs";\n\n` : ""}class Repository {
  constructor() { this.rows = []; }
  clear() { this.rows = []; }
  store(input) {
    const records = this.rows;
    ${saveBody}
  }
  all() { return structuredClone(this.rows); }
}
const repository = new Repository();
export const ${resetName} = () => repository.clear();
export const ${saveName} = (input) => repository.store(input);
export const ${listName} = () => repository.all();
export function ${renderName}(user) {
  ${renderBody}
}
`,
        },
        {
          build: (saveBody: string, renderBody: string, guarded: boolean) => `${guarded ? `import { ${validateName} } from "./user-schema.mjs";\n\n` : ""}const memory = (() => {
  let values = [];
  return {
    erase() { values = []; },
    write(input) {
      const records = values;
      const accepted = (() => {
        ${saveBody}
      })();
      values = records;
      return accepted;
    },
    copy() { return values.map((entry) => Object.assign({}, entry)); },
  };
})();
export function ${resetName}() { memory.erase(); }
export function ${saveName}(input) { return memory.write(input); }
export function ${listName}() { return memory.copy(); }
export function ${renderName}(user) { ${renderBody} }
`,
        },
        {
          build: (saveBody: string, renderBody: string, guarded: boolean) => `${guarded ? `import { ${validateName} } from "./user-schema.mjs";\n\n` : ""}let state = { records: [] };
const reduce = (current, command) => {
  if (command.kind === "clear") return { records: [] };
  if (command.kind === "replace") return { records: command.records };
  return current;
};
export function ${resetName}() { state = reduce(state, { kind: "clear" }); }
export function ${saveName}(input) {
  const records = state.records.slice();
  const accepted = (() => {
    ${saveBody}
  })();
  state = reduce(state, { kind: "replace", records });
  return accepted;
}
export function ${listName}() { return state.records.map((entry) => ({ ...entry })); }
export function ${renderName}(user) { ${renderBody} }
`,
        },
        {
          build: (saveBody: string, renderBody: string, guarded: boolean) => `${guarded ? `import { ${validateName} } from "./user-schema.mjs";\n\n` : ""}const index = new Map();
export function ${resetName}() { index.clear(); }
export function ${saveName}(input) {
  const records = [];
  const accepted = (() => {
    ${saveBody}
  })();
  for (const record of records) index.set(record.${contract.identityField}, record);
  return accepted;
}
export function ${listName}() { return [...index.values()].map((entry) => ({ ...entry })); }
export function ${renderName}(user) {
  ${renderBody}
}
`,
        },
      ];
      const shape = serviceShapes[shapeIndex];
      const unfixedContent = shape.build(rawSave, strictRender, false);
      const badPatchContent = shape.build(rawSave, safeRender, false);
      const goodPatchContent = shape.build(guardedSave, cleanRender, true);
      const invalidInput = JSON.stringify({ [contract.identityField]: "", [contract.displayField]: "" });
      const validInput = JSON.stringify({
        [contract.identityField]: ` ${contract.identity} `,
        [contract.displayField]: ` ${contract.display} `,
      });
      const importBlock = `import { ${listName}, ${renderName}, ${resetName}, ${saveName} } from "../src/service.mjs";`;
      const checkContents = [
        `${importBlock}
${resetName}();
const rejected = ${saveName}(${invalidInput});
const afterInvalid = ${listName}();
${resetName}();
const accepted = ${saveName}(${validInput});
const rows = ${listName}();
if (rejected === false && afterInvalid.length === 0 && accepted === true &&
    rows[0].${contract.identityField} === "${contract.identity}" &&
    ${renderName}(rows[0]) === "${contract.display.toUpperCase()}") {
  console.log("FIXED: invalid records stop at the write boundary");
  process.exit(0);
}
if (rejected && afterInvalid.length === 1 && ${renderName}(afterInvalid[0]) === "UNKNOWN") {
  console.log("CHECK_FAILED: presentation fallback masks persisted invalid data");
  process.exit(2);
}
console.log("UNFIXED: invalid records cross the repository boundary");
process.exit(1);
`,
        `${importBlock}
const scenarios = [
  { input: ${invalidInput}, accepted: false, count: 0 },
  { input: ${validInput}, accepted: true, count: 1 },
];
const ledger = [];
for (const scenario of scenarios) {
  ${resetName}();
  const accepted = ${saveName}(scenario.input);
  const rows = ${listName}();
  ledger.push({ accepted, count: rows.length, output: rows[0] ? ${renderName}(rows[0]) : null });
}
if (ledger[0].accepted === false && ledger[0].count === 0 &&
    ledger[1].accepted === true && ledger[1].count === 1 &&
    ledger[1].output === "${contract.display.toUpperCase()}") {
  console.log("FIXED: repository scenarios enforce the entity contract");
  process.exit(0);
}
if (ledger[0].accepted && ledger[0].output === "UNKNOWN") {
  console.log("CHECK_FAILED: repository corruption is hidden during rendering");
  process.exit(2);
}
console.log("UNFIXED: repository accepted a malformed entity");
process.exit(1);
`,
        `${importBlock}
${resetName}();
const transitions = [];
for (const input of [${invalidInput}, ${validInput}]) {
  const before = ${listName}().length;
  const accepted = ${saveName}(input);
  const after = ${listName}();
  transitions.push([before, accepted, after.length, after[0] ? ${renderName}(after[0]) : "EMPTY"]);
}
const wanted = [[0, false, 0, "EMPTY"], [0, true, 1, "${contract.display.toUpperCase()}"]];
if (JSON.stringify(transitions) === JSON.stringify(wanted)) {
  console.log("FIXED: closure store audit rejects invalid transitions");
  process.exit(0);
}
if (transitions[0][1] === true && transitions[0][3] === "UNKNOWN") {
  console.log("CHECK_FAILED: closure store relies on a caller-side placeholder");
  process.exit(2);
}
console.log("UNFIXED: closure store transition audit failed");
process.exit(1);
`,
        `${importBlock}
${resetName}();
const invalidAccepted = ${saveName}(${invalidInput});
const invalidSnapshot = ${listName}();
${resetName}();
const validAccepted = ${saveName}(${validInput});
const validSnapshot = ${listName}();
const snapshot = {
  invalidAccepted,
  invalidSnapshot,
  validAccepted,
  validSnapshot,
  view: validSnapshot[0] && ${renderName}(validSnapshot[0]),
};
const expected = {
  invalidAccepted: false,
  invalidSnapshot: [],
  validAccepted: true,
  validSnapshot: [{ ${contract.identityField}: "${contract.identity}", ${contract.displayField}: "${contract.display}" }],
  view: "${contract.display.toUpperCase()}",
};
if (JSON.stringify(snapshot) === JSON.stringify(expected)) {
  console.log("FIXED: reducer snapshot contains only validated entities");
  process.exit(0);
}
if (snapshot.invalidAccepted && ${renderName}(snapshot.invalidSnapshot[0]) === "UNKNOWN") {
  console.log("CHECK_FAILED: reducer output is sanitized after invalid insertion");
  process.exit(2);
}
console.log("UNFIXED: reducer state contains an invalid entity");
process.exit(1);
`,
        `${importBlock}
${resetName}();
const operations = [
  () => ${saveName}(${invalidInput}),
  () => ${listName}(),
  () => ${saveName}(${validInput}),
  () => ${listName}(),
];
const [invalidAccepted, invalidRows, validAccepted, validRows] = operations.map((operation) => operation());
const domainSafe = invalidAccepted === false && invalidRows.length === 0 &&
  validAccepted === true && validRows.length === 1 &&
  validRows[0].${contract.identityField} === "${contract.identity}";
if (domainSafe && ${renderName}(validRows[0]) === "${contract.display.toUpperCase()}") {
  console.log("FIXED: indexed storage contains only canonical entities");
  process.exit(0);
}
if (invalidAccepted && invalidRows.length && ${renderName}(invalidRows[0]) === "UNKNOWN") {
  console.log("CHECK_FAILED: indexed invalid data is concealed by presentation");
  process.exit(2);
}
console.log("UNFIXED: indexed storage violated the entity schema");
process.exit(1);
`,
      ];
      const checkScript: SyntheticFile = { path: "test/check.js", content: checkContents[shapeIndex] };
      return {
        files: [...commonFiles, checkScript, { path: schemaFile, content: schemaContent }, { path: file, content: unfixedContent }],
        badPatch: {
          id: "strategy_patch_caller_presentation_layer",
          description: "Add inline sanitization at presentation handler layer",
          files: [{ path: file, content: badPatchContent }],
        },
        goodPatch: {
          id: "strategy_fix_domain_schema_layer",
          description: "Update domain entity schema validator to enforce invariant globally",
          files: [{ path: file, content: goodPatchContent }, { path: schemaFile, content: schemaContent }],
        },
        noTrapFiles: [...commonFiles, checkScript, { path: schemaFile, content: schemaContent }, { path: file, content: goodPatchContent }],
        symbol,
        file,
        pattern,
        actionType,
      };
    }
  }
  throw new Error(`unsupported first trap fixture: ${trapId}`);
}
