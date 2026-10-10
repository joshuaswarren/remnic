import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plugin = fileURLToPath(new URL("./index.ts", import.meta.url));
const executable = fileURLToPath(new URL("../../../node_modules/.bin/oxlint", import.meta.url));

function lint(source, rule) {
  const directory = mkdtempSync(join(tmpdir(), "remnic-lint-rule-"));
  try {
    const config = join(directory, "config.json");
    const input = join(directory, "input.tsx");
    writeFileSync(config, JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [{ name: "anti-slop", specifier: plugin }],
      rules: { [`anti-slop/${rule}`]: "error" },
    }));
    writeFileSync(input, source);
    const result = spawnSync(executable, ["--config", config, "--format", "json", input], {
      encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    return JSON.parse(result.stdout).diagnostics;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("conditional spreads detect parenthesized empty branches", () => {
  const diagnostics = lint("const x = { ...(enabled ? ({}) : value), ...(enabled ? value : (({}))) };", "no-conditional-empty-object-spread");
  assert.equal(diagnostics.length, 2);
});

test("annotated dictionary accumulators retain their declared evidence on return", () => {
  const diagnostics = lint("function build(): Record<string, number> { const result: Record<string, number> = {}; result.count = 1; return result; }", "no-known-value-widening");
  assert.deepEqual(diagnostics, []);
  assert.equal(lint("function build(): Record<string, number> { const result = { count: 1 }; return result; }", "no-known-value-widening").length, 1);
});

test("module aliases ignore caller generic names during expansion", () => {
  assert.equal(lint("type Input = object; type Payload = Input; declare function use<Input>(value: Payload): void;", "no-object-parameters").length, 1);
  assert.deepEqual(lint("type Input = object; declare function use<Input>(value: Input): void;", "no-object-parameters"), []);
  assert.equal(lint("type Value = Promise<unknown>; type Result = Value; declare function read<Value>(): Result;", "no-unknown-returns").length, 1);
  assert.deepEqual(lint("type Value = unknown; declare function read<Value>(): Value;", "no-unknown-returns"), []);
});

test("external keys and JSX attributes retain their contract names", () => {
  assert.deepEqual(lint("const response = { shape: 1 }; response.shape; const view = <Widget data-shape='x' shape='x' />;", "no-shape-in-symbol-names"), []);
  assert.equal(lint("const shape = 1; const out = { shape };", "no-shape-in-symbol-names").length, 2);
});

test("unknown absorbs union members unless any is present", () => {
  assert.equal(lint("type BoundaryValue = string | unknown;", "no-unknown-type-aliases").length, 1);
  assert.deepEqual(lint("type BoundaryValue = unknown | any;", "no-unknown-type-aliases"), []);
  assert.equal(lint("type BoundaryValue = (string | (number | unknown));", "no-unknown-type-aliases").length, 1);
  assert.deepEqual(lint("type BoundaryValue = (string | (unknown | any));", "no-unknown-type-aliases"), []);
});

function unsafeValue(diagnostics) {
  const diagnostic = diagnostics.find((entry) => /This dictionary's (\S+) value type/.test(entry.message));
  return diagnostic?.message.match(/This dictionary's (\S+) value type/)?.[1] ?? null;
}

test("composite alias applications keep typed values safe", () => {
	const source = [
		"type Inner<T> = T;",
		"type Outer<T> = Inner<Readonly<T>>;",
		"export type Payload = Outer<string>;",
		"export declare function handle(values: Record<string, Payload>): void;",
	].join("\n");
	assert.deepEqual(lint(source, "no-unsafe-dictionary-type"), []);
});

test("composite alias applications report unknown values", () => {
	const source = [
		"type Inner<T> = T;",
		"type Outer<T> = Inner<Readonly<T>>;",
		"export type Payload = Outer<unknown>;",
		"export declare function handle(values: Record<string, Payload>): void;",
	].join("\n");
	const diagnostics = lint(source, "no-unsafe-dictionary-type");
	assert.equal(diagnostics.length, 1);
	assert.equal(unsafeValue(diagnostics), "unknown");
});

test("declaring a composite alias body over a free parameter stays inert", () => {
	const source = "type Inner<T> = T;\ntype Outer<T> = Inner<Readonly<T>>;\n";
	assert.deepEqual(lint(source, "no-unsafe-dictionary-type"), []);
});

test("type arguments resolve in the caller scope", () => {
	const typed = "type Wrap<V> = V;\ntype Outer<T> = Wrap<Readonly<T>>;\nexport declare function handle(values: Record<string, Outer<string>>): void;\n";
	assert.deepEqual(lint(typed, "no-unsafe-dictionary-type"), []);
	const unknownValue = "type Wrap<V> = V;\ntype Outer<T> = Wrap<Readonly<T>>;\nexport declare function handle(values: Record<string, Outer<unknown>>): void;\n";
	const diagnostics = lint(unknownValue, "no-unsafe-dictionary-type");
	assert.equal(diagnostics.length, 1);
	assert.equal(unsafeValue(diagnostics), "unknown");
});

test("defaults resolve with earlier callee parameters", () => {
	const typed = "type Wrap<T, V = Readonly<T>> = V;\nexport declare function handle(values: Record<string, Wrap<string>>): void;\n";
	assert.deepEqual(lint(typed, "no-unsafe-dictionary-type"), []);
	const unknownValue = "type Wrap<T, V = Readonly<T>> = V;\nexport declare function handle(values: Record<string, Wrap<unknown>>): void;\n";
	const diagnostics = lint(unknownValue, "no-unsafe-dictionary-type");
	assert.equal(diagnostics.length, 1);
	assert.equal(unsafeValue(diagnostics), "unknown");
});

test("widening targets through composite alias applications still classify", () => {
	const source = [
		"type Dict<T> = { [K in string]: T };",
		"type Mid<T> = Dict<Readonly<T>>;",
		"export function build(): Mid<unknown> { const result = { count: 1 }; return result; }",
	].join("\n");
	assert.equal(lint(source, "no-known-value-widening").length, 1);
	const retained = [
		"type Dict<T> = { [K in string]: T };",
		"type Mid<T> = Dict<Readonly<T>>;",
		"export function build(): Mid<string> { const result: Mid<string> = {}; result.size = 1; return result; }",
	].join("\n");
	assert.deepEqual(lint(retained, "no-known-value-widening"), []);
});