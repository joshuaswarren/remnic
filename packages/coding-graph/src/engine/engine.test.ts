/**
 * Engine test suite (issue #1551 PR2):
 *   1. Gate-off parity — createCodingGraphEngine no longer throws
 *   2. Fixture-IR snapshot tests — all 15 tier-1 languages
 *   3. Determinism — same file parsed twice → byte-identical serialized IR
 *   4. Error handling — unsupported language returns parse_failed, no throw
 *   5. Qualified-name nesting — parent linkage is correct
 *   6. Dispose lifecycle — engine can be disposed and re-created
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { TIER_1_LANGUAGES, type CodingGraphLanguage, type FileIR } from "@remnic/core";

import { createCodingGraphEngine } from "./engine.js";
import { FIXTURES } from "./fixtures.js";
import { hashContent } from "./emit.js";
import { sniffLanguage } from "./language-sniff.js";
import { WasmTreeSitterBackend } from "./parser-backend.js";

// ---------------------------------------------------------------------------
// Deterministic IR serialization — sorts every collection and object key so
// the output is byte-identical across runs (rule 38).
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return result;
}

function serializeIR(ir: FileIR): string {
  return JSON.stringify(canonicalize(ir));
}

// ---------------------------------------------------------------------------
// 1. Gate-off parity — createCodingGraphEngine no longer throws.
//    PR1 threw CodingGraphError("not_implemented"); PR2 returns a real engine.
// ---------------------------------------------------------------------------

test("gate-off: createCodingGraphEngine does not throw (no longer not_implemented)", () => {
  const engine = createCodingGraphEngine();
  assert.equal(typeof engine.engineVersion, "string");
  assert.ok(engine.engineVersion.length > 0);
  assert.ok(engine.supportedLanguages.length >= 15);
  assert.deepEqual(
    [...engine.supportedLanguages].sort(),
    [...TIER_1_LANGUAGES].sort(),
  );
});

test("gate-off: engine reports correct version from @remnic/core", () => {
  const engine = createCodingGraphEngine();
  // The version must match the single source of truth in core.
  assert.equal(engine.engineVersion, "0.1.0-pr1");
});

// ---------------------------------------------------------------------------
// 2. Fixture-IR snapshot tests for all 15 tier-1 languages.
//
// Each fixture is parsed and its IR is validated for structural correctness:
//   - contentHash is a 64-char hex SHA-256 of the raw bytes
//   - symbols have correct kinds, names, qualified names, and parent linkage
//   - imports have correct module specifiers
//   - the IR path and language match the input
//
// The serialized IR is also captured as a snapshot string for future
// regression comparison.
// ---------------------------------------------------------------------------

test("fixture-IR: all tier-1 languages produce valid IR", async (t) => {
  const engine = createCodingGraphEngine();

  for (const lang of TIER_1_LANGUAGES) {
    await t.test(`${lang} fixture parses successfully`, async () => {
      const fixture = FIXTURES[lang];
      const content = Buffer.from(fixture.code, "utf-8");
      const result = await engine.parseFile({
        path: fixture.path,
        content,
      });

      assert.ok(result.ok, `${lang}: parseFile must succeed, got: ${result.ok ? "" : result.message}`);
      if (!result.ok) return;

      const ir = result.ir;

      // Path and language match.
      assert.equal(ir.path, fixture.path, `${lang}: path mismatch`);
      assert.equal(ir.language, lang, `${lang}: language mismatch`);

      // contentHash is a valid SHA-256 hex string of the raw bytes.
      assert.equal(ir.contentHash, hashContent(content), `${lang}: contentHash mismatch`);
      assert.match(ir.contentHash, /^[0-9a-f]{64}$/, `${lang}: contentHash must be SHA-256 hex`);

      // Every symbol has required fields.
      for (const sym of ir.symbols) {
        assert.ok(sym.name.length > 0, `${lang}: symbol name must be non-empty`);
        assert.ok(sym.qualifiedName.length > 0, `${lang}: qualifiedName must be non-empty`);
        assert.ok(sym.span.endByte > sym.span.startByte, `${lang}: span must be non-empty`);
      }

      // Every import has a module.
      for (const imp of ir.imports) {
        assert.ok(imp.module.length > 0, `${lang}: import module must be non-empty`);
        assert.ok(imp.span.endByte > imp.span.startByte, `${lang}: import span must be non-empty`);
      }

      // Capture snapshot for regression detection.
      const snapshot = serializeIR(ir);
      assert.ok(snapshot.length > 0, `${lang}: IR must serialize`);
    });
  }

  await engine.dispose();
});

// ---------------------------------------------------------------------------
// Per-language structural assertions — verify specific symbols, imports,
// exports, and call sites for representative languages.
// ---------------------------------------------------------------------------

test("fixture-IR: TypeScript has correct symbol structure", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.typescript;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const ir = result.ir;

  // Should have at least: AppOptions (interface), Mode (type), Server (class),
  // createServer (function), and the methods inside Server.
  const names = ir.symbols.map((s) => s.name);
  assert.ok(names.includes("AppOptions"), `TS: expected AppOptions, got ${names.join(", ")}`);
  assert.ok(names.includes("Mode"), `TS: expected Mode, got ${names.join(", ")}`);
  assert.ok(names.includes("Server"), `TS: expected Server, got ${names.join(", ")}`);
  assert.ok(names.includes("createServer"), `TS: expected createServer, got ${names.join(", ")}`);

  // Server class should have qualified name "Server" and contain a method.
  const server = ir.symbols.find((s) => s.name === "Server");
  assert.ok(server, "TS: Server symbol must exist");
  assert.equal(server!.kind, "class");

  // The method start() should be nested under Server.
  const startMethod = ir.symbols.find((s) => s.name === "start");
  assert.ok(startMethod, "TS: start method must exist");
  assert.equal(startMethod!.kind, "method");
  assert.ok(
    startMethod!.parentQualifiedName?.includes("Server"),
    `TS: start should be under Server, got parentQualifiedName=${startMethod!.parentQualifiedName}`,
  );

  // Imports: express + types.
  assert.ok(ir.imports.some((i) => i.module === "express"), "TS: should import express");
  assert.ok(ir.imports.some((i) => i.module === "./types"), "TS: should import ./types");

  // Exports.
  const exportNames = ir.exports.map((e) => e.name);
  assert.ok(exportNames.includes("AppOptions"), `TS: should export AppOptions, got ${exportNames.join(", ")}`);
  assert.ok(exportNames.includes("Server"), `TS: should export Server`);
  assert.ok(exportNames.includes("createServer"), `TS: should export createServer`);

  await engine.dispose();
});

test("fixture-IR: Python has correct class/method nesting", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.python;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const ir = result.ir;

  const user = ir.symbols.find((s) => s.name === "User");
  assert.ok(user, "Python: User class must exist");
  assert.equal(user!.kind, "class");

  const greet = ir.symbols.find((s) => s.name === "greet");
  assert.ok(greet, "Python: greet method must exist");
  assert.equal(greet!.kind, "function"); // tree-sitter-python treats def as function_definition
  assert.ok(
    greet!.parentQualifiedName?.includes("User"),
    `Python: greet should be under User, got ${greet!.parentQualifiedName}`,
  );

  // format_name and main should be top-level functions.
  const formatName = ir.symbols.find((s) => s.name === "format_name");
  assert.ok(formatName, "Python: format_name must exist");
  assert.ok(!formatName!.parentQualifiedName, "Python: format_name should be top-level");

  // Imports.
  assert.ok(ir.imports.some((i) => i.module === "typing"), "Python: should import from typing");
  assert.ok(ir.imports.some((i) => i.module === "dataclasses"), "Python: should import from dataclasses");

  await engine.dispose();
});

test("fixture-IR: Go has struct/function/method structure", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.go;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const ir = result.ir;

  const server = ir.symbols.find((s) => s.name === "Server");
  assert.ok(server, "Go: Server struct must exist");
  assert.equal(server!.kind, "class"); // struct_type → class

  const start = ir.symbols.find((s) => s.name === "Start");
  assert.ok(start, "Go: Start method must exist");
  assert.equal(start!.kind, "method"); // method_declaration → method

  assert.ok(ir.imports.some((i) => i.module === "fmt"), "Go: should import fmt");

  await engine.dispose();
});

test("fixture-IR: Rust has struct/impl/trait structure", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.rust;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const ir = result.ir;

  const add = ir.symbols.find((s) => s.name === "add");
  assert.ok(add, "Rust: add function must exist");
  assert.equal(add!.kind, "function");

  const config = ir.symbols.find((s) => s.name === "Config");
  assert.ok(config, "Rust: Config struct must exist");
  assert.equal(config!.kind, "class");

  const service = ir.symbols.find((s) => s.name === "Service");
  assert.ok(service, "Rust: Service trait must exist");
  assert.equal(service!.kind, "interface");

  assert.ok(ir.imports.some((i) => i.module === "std::collections::HashMap"), "Rust: should import HashMap");

  await engine.dispose();
});

test("fixture-IR: C# has class/interface structure", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.csharp;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const ir = result.ir;
  const names = ir.symbols.map((s) => s.name);
  assert.ok(names.includes("Server"), `C#: expected Server, got ${names.join(", ")}`);
  assert.ok(names.includes("IService"), `C#: expected IService, got ${names.join(", ")}`);
  assert.ok(ir.imports.some((i) => i.module === "System"), "C#: should import System");

  await engine.dispose();
});

test("fixture-IR: Ruby has class/module structure", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.ruby;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const ir = result.ir;
  const userClass = ir.symbols.find((s) => s.name === "User");
  assert.ok(userClass, "Ruby: User class must exist");
  assert.equal(userClass!.kind, "class");

  const authModule = ir.symbols.find((s) => s.name === "Auth");
  assert.ok(authModule, "Ruby: Auth module must exist");
  assert.equal(authModule!.kind, "module");

  assert.ok(ir.imports.some((i) => i.module === "json"), "Ruby: should require json");

  await engine.dispose();
});

test("fixture-IR: JavaScript has class/method/function structure", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.javascript;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const ir = result.ir;
  const names = ir.symbols.map((s) => s.name);
  assert.ok(names.includes("createRouter"), `JS: expected createRouter, got ${names.join(", ")}`);
  assert.ok(names.includes("App"), `JS: expected App class, got ${names.join(", ")}`);

  const app = ir.symbols.find((s) => s.name === "App");
  assert.ok(app, "JS: App class must exist");
  assert.equal(app!.kind, "class");

  await engine.dispose();
});

test("fixture-IR: C has function/typedef structure", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.c;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const ir = result.ir;
  const add = ir.symbols.find((s) => s.name === "add");
  assert.ok(add, "C: add function must exist");
  assert.equal(add!.kind, "function");

  assert.ok(ir.imports.some((i) => i.module === "stdio.h"), "C: should include stdio.h");
  assert.ok(ir.imports.some((i) => i.module === "string.h"), "C: should include string.h");

  await engine.dispose();
});

test("fixture-IR: Java has class/interface/method structure", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.java;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const ir = result.ir;
  const names = ir.symbols.map((s) => s.name);
  assert.ok(names.includes("Server"), `Java: expected Server, got ${names.join(", ")}`);
  assert.ok(names.includes("Handler"), `Java: expected Handler, got ${names.join(", ")}`);

  // Server.start should be a method.
  const start = ir.symbols.find((s) => s.name === "start");
  assert.ok(start, "Java: start method must exist");
  assert.equal(start!.kind, "method");
  assert.ok(start!.parentQualifiedName?.includes("Server"), "Java: start should be under Server");

  assert.ok(ir.imports.some((i) => i.module === "java.util.List"), "Java: should import java.util.List");

  await engine.dispose();
});

// ---------------------------------------------------------------------------
// 2b. Review-thread fixes (#1551 PR2 — PR #1652).
//   - CommonJS require() imports (threads PRRT_kwDORJXyws6Oc9au / -M8)
//   - Arrow/function-expression declarators as symbols (thread -M-)
//   - Full C# qualified_name in using directives (thread -NB)
//   - Failed grammar load allows retry, not a cached rejection (thread 9at)
// ---------------------------------------------------------------------------

test("require-imports: CommonJS require() produces an import edge", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.javascript; // starts with: const express = require("express");
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.ok(
    result.ir.imports.some((i) => i.module === "express"),
    `JS: require("express") must produce an import, got modules: ${result.ir.imports.map((i) => i.module).join(", ")}`,
  );

  await engine.dispose();
});

test("require-imports: CommonJS require with destructuring variants", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    'const path = require("path");',
    'const { readFile } = require("fs");',
    "",
    "function main() { readFile('x'); }",
    "",
    "module.exports = { main };",
  ].join("\n");
  const result = await engine.parseFile({ path: "lib/cjs.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;

  const modules = result.ir.imports.map((i) => i.module);
  assert.ok(modules.includes("path"), `should import path via require, got: ${modules.join(", ")}`);
  assert.ok(modules.includes("fs"), `should import fs via require, got: ${modules.join(", ")}`);

  await engine.dispose();
});

test("arrow-fn-decls: const handler = () => {} indexed as function symbol", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.tsx; // contains: export const Container = () => { ... };
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const container = result.ir.symbols.find((s) => s.name === "Container");
 assert.ok(container, "TSX: Container arrow-fn symbol must exist");
 assert.equal(container!.kind, "function", "TSX: Container should be a function symbol");

  await engine.dispose();
});

test("arrow-fn-decls: function-expression declarators also indexed", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    'import { Router } from "express";',
    "",
    "const handler = function () { return 42; };",
    "const arrow = () => { return handler(); };",
    "",
    "export { handler, arrow };",
  ].join("\n");
  const result = await engine.parseFile({ path: "src/fns.ts", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;

  const names = result.ir.symbols.map((s) => s.name);
  assert.ok(names.includes("handler"), `TS: function-expression declarator should be a symbol, got: ${names.join(", ")}`);
  assert.ok(names.includes("arrow"), `TS: arrow-function declarator should be a symbol, got: ${names.join(", ")}`);

  await engine.dispose();
});

test("csharp-usings: qualified namespace captured in full", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.csharp; // contains: using System.Collections.Generic;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const modules = result.ir.imports.map((i) => i.module);
  assert.ok(
    modules.includes("System.Collections.Generic"),
    `C#: using System.Collections.Generic must capture the full qualified name, got: ${modules.join(", ")}`,
  );
  assert.ok(modules.includes("System"), "C#: simple using System should still work");

  await engine.dispose();
});

test("retry: failed grammar load allows a fresh retry, not a cached rejection", async () => {
  // Point the backend at a nonexistent grammar dir so Language.load rejects.
  const backend = new WasmTreeSitterBackend(`/nonexistent-grammar-${Date.now()}`);
  await backend.init(); // Parser.init() succeeds without grammar files.

  // First load attempt fails — the wasm file doesn't exist.
  const p1 = backend.ensureLanguage("javascript");
  try {
    await p1;
    assert.fail("first ensureLanguage should have rejected on a missing grammar");
  } catch {
    // expected ENOENT / load failure
  }

  // Second attempt: before the fix, loadingLanguages was never cleaned on
  // failure, so this returned the SAME cached rejected promise. After the
  // fix, the finally block clears the cache, so this is a FRESH attempt
  // (a brand-new promise that re-runs Language.load).
  const p2 = backend.ensureLanguage("javascript");
  try {
    await p2;
  } catch {
    // expected to fail again (still the same bad dir)
  }

  assert.notStrictEqual(
    p1,
    p2,
    "retry must return a fresh promise, not the cached rejection — loadingLanguages should be cleared on failure",
  );

  await backend.dispose();
});

// ---------------------------------------------------------------------------
// 3. Determinism — same file parsed twice must produce byte-identical IR.
// ---------------------------------------------------------------------------

test("determinism: same file parsed twice yields byte-identical IR", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.typescript;
  const content = Buffer.from(fixture.code, "utf-8");

  const result1 = await engine.parseFile({ path: fixture.path, content });
  const result2 = await engine.parseFile({ path: fixture.path, content });

  assert.ok(result1.ok && result2.ok, "both parses must succeed");
  if (!result1.ok || !result2.ok) return;

  const ir1 = serializeIR(result1.ir);
  const ir2 = serializeIR(result2.ir);

  assert.equal(ir1, ir2, "IR must be byte-identical across two parses of the same file");
});

test("determinism: two separate engine instances produce identical IR", async () => {
  const engine1 = createCodingGraphEngine();
  const engine2 = createCodingGraphEngine();
  const fixture = FIXTURES.python;
  const content = Buffer.from(fixture.code, "utf-8");

  const result1 = await engine1.parseFile({ path: fixture.path, content });
  const result2 = await engine2.parseFile({ path: fixture.path, content });

  assert.ok(result1.ok && result2.ok);
  if (!result1.ok || !result2.ok) return;

  assert.equal(serializeIR(result1.ir), serializeIR(result2.ir));

  await engine1.dispose();
  await engine2.dispose();
});

test("determinism: contentHash matches manual SHA-256 of raw bytes", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.go;
  const content = Buffer.from(fixture.code, "utf-8");
  const expected = createHash("sha256").update(content).digest("hex");

  const result = await engine.parseFile({ path: fixture.path, content });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.ir.contentHash, expected, "contentHash must be SHA-256 of raw bytes");

  await engine.dispose();
});

// ---------------------------------------------------------------------------
// 4. Error handling — unsupported language returns parse_failed (rule 44).
// ---------------------------------------------------------------------------

test("error: unsupported file extension returns parse_failed", async () => {
  const engine = createCodingGraphEngine();
  const result = await engine.parseFile({
    path: "readme.md",
    content: Buffer.from("# Hello", "utf-8"),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "parse_failed");
  assert.equal(result.path, "readme.md");
  assert.ok(result.message.includes("unsupported language"), `unexpected message: ${result.message}`);

  await engine.dispose();
});

test("error: explicit language override is respected", async () => {
  const engine = createCodingGraphEngine();
  const result = await engine.parseFile({
    path: "unknown.xyz",
    content: Buffer.from("function f() {}", "utf-8"),
    language: "javascript",
  });

  assert.ok(result.ok, "explicit language override should work");

  await engine.dispose();
});

// ---------------------------------------------------------------------------
// 5. Language sniffing — extension mapping.
// ---------------------------------------------------------------------------

test("sniff: file extensions map to correct languages", () => {
  assert.equal(sniffLanguage("foo.ts"), "typescript");
  assert.equal(sniffLanguage("foo.tsx"), "tsx");
  assert.equal(sniffLanguage("foo.js"), "javascript");
  assert.equal(sniffLanguage("foo.mjs"), "javascript");
  assert.equal(sniffLanguage("foo.py"), "python");
  assert.equal(sniffLanguage("foo.go"), "go");
  assert.equal(sniffLanguage("foo.rs"), "rust");
  assert.equal(sniffLanguage("foo.java"), "java");
  assert.equal(sniffLanguage("foo.c"), "c");
  assert.equal(sniffLanguage("foo.h"), "c");
  assert.equal(sniffLanguage("foo.cpp"), "cpp");
  assert.equal(sniffLanguage("foo.hpp"), "cpp");
  assert.equal(sniffLanguage("foo.cs"), "csharp");
  assert.equal(sniffLanguage("foo.rb"), "ruby");
  assert.equal(sniffLanguage("foo.php"), "php");
  assert.equal(sniffLanguage("foo.kt"), "kotlin");
  assert.equal(sniffLanguage("foo.swift"), "swift");
  assert.equal(sniffLanguage("foo.sh"), "bash");
  assert.equal(sniffLanguage("foo.bash"), "bash");
  assert.equal(sniffLanguage("foo.unknown"), null);
  assert.equal(sniffLanguage("noextension"), null);
});

// ---------------------------------------------------------------------------
// 6. Dispose lifecycle.
// ---------------------------------------------------------------------------

test("lifecycle: dispose releases resources; engine can be recreated", async () => {
  const engine1 = createCodingGraphEngine();
  const fixture = FIXTURES.javascript;
  const result1 = await engine1.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result1.ok, "first engine should work before dispose");
  await engine1.dispose();

  // After dispose, parseFile should return parse_failed.
  const resultAfterDispose = await engine1.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.equal(resultAfterDispose.ok, false, "disposed engine should fail");

  // A new engine works fine.
  const engine2 = createCodingGraphEngine();
  const result2 = await engine2.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result2.ok, "new engine should work after disposing the old one");
  await engine2.dispose();
});

test("lifecycle: double dispose is safe", async () => {
  const engine = createCodingGraphEngine();
  await engine.dispose();
  await engine.dispose(); // should not throw
});
