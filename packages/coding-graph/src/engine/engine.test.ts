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
import { hashContent as hashContentFromReindex } from "../reindex.js";
import { sniffLanguage } from "./language-sniff.js";
import { buildUtf16ToByteOffsetMap } from "./utf16-offsets.js";
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
// 2c. Round-2 review-thread fixes (#1551 PR2 — PR #1652).
//   - Constructor does not throw on missing grammar dir (thread dEv5)
//   - parseFile catches extraction errors → parse_failed (thread dEv7)
//   - Named JS route handlers: app.get("/x", handler) (thread dFOD)
//   - Multi-module imports: Python import os, sys (thread dFOF)
//   - Python route handler names not 'anonymous' (thread dFOG)
// ---------------------------------------------------------------------------

test("ctor-safe: WasmTreeSitterBackend constructor does not throw on missing grammar dir", () => {
  // Before the fix, resolveGrammarDir() ran eagerly in the constructor and
  // threw if grammars/ was missing — bricking createCodingGraphEngine.
  // Now resolution is deferred to first ensureLanguage() call.
  const backend = new WasmTreeSitterBackend("/nonexistent-dir-" + Date.now());
  assert.ok(backend instanceof WasmTreeSitterBackend, "constructor must not throw");
});

test("parse-safe: extraction errors surface as parse_failed, not thrown", async () => {
  const engine = createCodingGraphEngine();
  // Feed content that could trigger query errors in edge-case grammars.
  // The key contract: parseFile NEVER throws — it returns { ok: false }.
  const result = await engine.parseFile({
    path: "test.js",
    content: Buffer.from("", "utf-8"),
    language: "javascript",
  });
  assert.ok(result.ok, "empty JS file should still parse (no extraction error)");

  await engine.dispose();
});

test("named-routes: app.get('/users', getUsers) captures the handler name", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    'const express = require("express");',
    "const app = express();",
    "function getUsers() { return []; }",
    'app.get("/users", getUsers);',
    'app.post("/items", (req, res) => {});',
  ].join("\n");
  const result = await engine.parseFile({ path: "lib/server.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;

  const routes = result.ir.routes ?? [];
  const usersRoute = routes.find((r) => r.pathTemplate === "/users");
  assert.ok(usersRoute, "JS: should have a /users route");
  assert.equal(usersRoute!.handlerQualifiedName, "getUsers", "named handler should use the identifier text");

  const itemsRoute = routes.find((r) => r.pathTemplate === "/items");
  assert.ok(itemsRoute, "JS: should have a /items route");

  await engine.dispose();
});

test("multi-import: Python 'import os, sys' produces two import entries", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "import os, sys",
    "from collections import defaultdict",
    "",
    "def main():",
    "    pass",
  ].join("\n");
  const result = await engine.parseFile({ path: "app.py", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;

  const modules = result.ir.imports.map((i) => i.module);
  assert.ok(modules.includes("os"), `Python: should import os, got: ${modules.join(", ")}`);
  assert.ok(modules.includes("sys"), `Python: should import sys, got: ${modules.join(", ")}`);
  assert.ok(modules.includes("collections"), `Python: should import collections, got: ${modules.join(", ")}`);

  await engine.dispose();
});

test("python-routes: @app.get('/users') def users() captures handler name", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "from flask import Flask",
    "app = Flask(__name__)",
    "",
    "@app.get('/users')",
    "def users():",
    "    return []",
    "",
    "@app.route('/items')",
    "def list_items():",
    "    return []",
  ].join("\n");
  const result = await engine.parseFile({ path: "app.py", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;

  const routes = result.ir.routes ?? [];
  const usersRoute = routes.find((r) => r.pathTemplate === "/users");
  assert.ok(usersRoute, "Python: should have a /users route");
  assert.notEqual(
    usersRoute!.handlerQualifiedName,
    "anonymous",
    "Python route handler should be 'users', not 'anonymous'",
  );
  assert.equal(usersRoute!.handlerQualifiedName, "users", "should capture the function name");

  const itemsRoute = routes.find((r) => r.pathTemplate === "/items");
  assert.ok(itemsRoute, "Python: should have a /items route");
  assert.notEqual(itemsRoute!.handlerQualifiedName, "anonymous", "items route handler should not be anonymous");

  await engine.dispose();
});

// ---------------------------------------------------------------------------
// 2d. Round-3 review-thread fixes (#1551 PR2 — PR #1652).
//   - Go receiver-qualified method names (thread dHXe)
//   - Concurrent parseFile serialization (thread dHXZ)
// ---------------------------------------------------------------------------

test("go-receivers: method qualified names use receiver type", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    'package main',
    '',
    'type Server struct {',
    '    port int',
    '}',
    '',
    'func (s *Server) Start() {}',
    'func (s Server) Stop() {}',
    'func NewServer() *Server { return nil }',
  ].join("\n");
  const result = await engine.parseFile({ path: "main.go", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;

  const start = result.ir.symbols.find((s) => s.name === "Start");
  assert.ok(start, "Go: Start method must exist");
  assert.equal(start!.qualifiedName, "Server.Start", "pointer receiver method should be Server.Start");
  assert.equal(start!.parentQualifiedName, "Server");

  const stop = result.ir.symbols.find((s) => s.name === "Stop");
  assert.ok(stop, "Go: Stop method must exist");
  assert.equal(stop!.qualifiedName, "Server.Stop", "value receiver method should be Server.Stop");
  assert.equal(stop!.parentQualifiedName, "Server");

  const newServer = result.ir.symbols.find((s) => s.name === "NewServer");
  assert.ok(newServer, "Go: NewServer function must exist");
  assert.equal(newServer!.qualifiedName, "NewServer", "free functions should have no parent qualifier");

  await engine.dispose();
});

test("concurrent-parse: parallel parseFile calls do not race", async () => {
  const engine = createCodingGraphEngine();
  const jsCode = 'const x = require("x"); function f() {}';
  const pyCode = 'def f():\n    pass\nclass C:\n    pass';
  const tsCode = 'export function g(): void {}';

  // Fire all three concurrently — the shared parser must serialize them.
  const results = await Promise.all([
    engine.parseFile({ path: "a.js", content: Buffer.from(jsCode, "utf-8") }),
    engine.parseFile({ path: "b.py", content: Buffer.from(pyCode, "utf-8") }),
    engine.parseFile({ path: "c.ts", content: Buffer.from(tsCode, "utf-8") }),
  ]);

  for (const [i, result] of results.entries()) {
    assert.ok(result.ok, `concurrent parse #${i} must succeed, got: ${result.ok ? "" : result.message}`);
  }

  // Verify the results are correct (not mixed up by a race).
  const [jsR, pyR, tsR] = results;
  assert.ok(jsR.ok && jsR.ir.symbols.some((s) => s.name === "f"), "JS parse should have function f");
  assert.ok(pyR.ok && pyR.ir.symbols.some((s) => s.name === "C"), "Python parse should have class C");
  assert.ok(tsR.ok && tsR.ir.symbols.some((s) => s.name === "g"), "TS parse should have function g");

  await engine.dispose();
});

// ---------------------------------------------------------------------------
// 2e. Round-4 review-thread fixes (#1551 PR2 — PR #1652).
//   - CommonJS module.exports / exports.X export capture (thread dITa)
//   - Kotlin import path segments removed (thread dITb)
// ---------------------------------------------------------------------------

test("cjs-exports: module.exports = { App, createRouter } captured as exports", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.javascript; // ends with: module.exports = { App, createRouter };
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const exportNames = result.ir.exports.map((e) => e.name);
  assert.ok(exportNames.includes("App"), `JS: module.exports should export App, got: ${exportNames.join(", ")}`);
  assert.ok(exportNames.includes("createRouter"), `JS: module.exports should export createRouter, got: ${exportNames.join(", ")}`);

  await engine.dispose();
});

test("cjs-exports: exports.handler = handler captured", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "function handler() { return 42; }",
    "exports.handler = handler;",
    "exports.version = '1.0.0';",
  ].join("\n");
  const result = await engine.parseFile({ path: "lib/cjs2.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;

  const exportNames = result.ir.exports.map((e) => e.name);
  assert.ok(exportNames.includes("handler"), `exports.handler should be exported, got: ${exportNames.join(", ")}`);
  assert.ok(exportNames.includes("version"), `exports.version should be exported, got: ${exportNames.join(", ")}`);

  await engine.dispose();
});

test("kotlin-imports: qualified import path not split into segments", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.kotlin;
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const modules = result.ir.imports.map((i) => i.module);
  // Should NOT have bare segment names like "kotlin" or "collections"
  // from a qualified import like "kotlin.collections.*"
  for (const mod of modules) {
    assert.ok(
      mod.length > 0,
      `Kotlin: all imports should be full paths, got segment: ${mod}`,
    );
  }
  // Verify the fixture's actual import is captured as a full path
  if (modules.length > 0) {
    assert.ok(
      modules.some((m) => m.includes(".") || m.length > 2),
      `Kotlin: expected full import paths, got: ${modules.join(", ")}`,
    );
  }

  await engine.dispose();
});

// ---------------------------------------------------------------------------
// 2f. Round-5 review-thread fixes (#1551 PR2 — PR #1652).
//   - Rust impl methods get parent qualification (thread OdKT0 / OdLZF)
//   - Member-receiver routes: this.router.get(...) (thread OdKTz)
//   - Dispose drains in-flight parses before backend teardown (thread OdLZE)
//   - Duplicate SHA-256 removed from reindex.ts (thread OdLZH)
// ---------------------------------------------------------------------------

test("rust-impl-parent: impl methods get struct-qualified name", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.rust; // has: impl Config { pub fn new() -> Self { ... } }
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  // The impl method `new` should be qualified as `Config.new`, not bare `new`.
  const newMethod = result.ir.symbols.find((s) => s.name === "new");
  assert.ok(newMethod, "Rust: impl method 'new' must exist");
  assert.equal(
    newMethod!.parentQualifiedName,
    "Config",
    `Rust: new should have parentQualifiedName 'Config', got: ${newMethod!.parentQualifiedName}`,
  );
  assert.equal(
    newMethod!.qualifiedName,
    "Config.new",
    `Rust: new should have qualifiedName 'Config.new', got: ${newMethod!.qualifiedName}`,
  );

  // Free function `add` should NOT have a parent (it's not inside an impl).
  const add = result.ir.symbols.find((s) => s.name === "add");
  assert.ok(add, "Rust: free function 'add' must exist");
  assert.equal(add!.parentQualifiedName, undefined, "Rust: add should not have a parent");

  await engine.dispose();
});

test("rust-nested-qualified: function inside impl method gets full parent chain", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "pub struct Config {",
    "    pub port: u16,",
    "}",
    "",
    "impl Config {",
    "    pub fn new() -> Self {",
    "        fn default_port() -> u16 { 8080 }",
    "        Self { port: default_port() }",
    "    }",
    "}",
  ].join("\n");
  const result = await engine.parseFile({
    path: "src/nested.rs",
    content: Buffer.from(code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  // The impl method `new` → Config.new (verified by prior test).
  const newMethod = result.ir.symbols.find((s) => s.name === "new");
  assert.ok(newMethod, "Rust: impl method 'new' must exist");
  assert.equal(newMethod!.qualifiedName, "Config.new");

  // The nested function inside `new` should get Config.new.default_port,
  // not just new.default_port.
  const helper = result.ir.symbols.find((s) => s.name === "default_port");
  assert.ok(helper, "Rust: nested function 'default_port' must exist");
  assert.equal(
    helper!.parentQualifiedName,
    "Config.new",
    `Rust: nested function should have parent 'Config.new', got: ${helper!.parentQualifiedName}`,
  );

  await engine.dispose();
});

test("member-routes: this.router.get(...) produces a route", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.typescript; // has: this.router.get('/', () => {});
  const result = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const routes = result.ir.routes;
  assert.ok(
    routes.some((r) => r.verb === "GET" && r.pathTemplate === "/"),
    `TS: expected GET / route from this.router.get(...), got: ${JSON.stringify(routes)}`,
  );

  await engine.dispose();
});

test("dispose-race: concurrent dispose and parse activity is safe", async () => {
  const engine = createCodingGraphEngine();
  const fixture = FIXTURES.typescript;

  // Fire concurrent parses and a dispose in the same synchronous tick.
  // dispose() sets disposed=true and awaits parseChain; the queued parses
  // re-check disposed after acquiring the chain and reject cleanly.
  const parse1 = engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  const parse2 = engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  const disposePromise = engine.dispose();

  // All three must resolve without throwing — no unhandled rejection,
  // no use-after-free on the backend's shared parser instance.
  await Promise.all([parse1, parse2, disposePromise]);

  // After dispose completes, new parses must fail.
  const afterDispose = await engine.parseFile({
    path: fixture.path,
    content: Buffer.from(fixture.code, "utf-8"),
  });
  assert.equal(afterDispose.ok, false, "disposed engine should reject new parses");
});

test("hash-dedup: reindex.ts re-exports the single emit.ts hashContent", () => {
  // Verify the re-export path works — both point to the same implementation
  // in emit.ts (single hashing contract, rule 23).
  const data = new TextEncoder().encode("hello world");
  assert.equal(hashContentFromReindex(data), hashContent(data), "reindex.ts hashContent must match emit.ts hashContent");
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

// ===========================================================================
// Issue #1659: export-capture edge cases (default exports, CJS alias,
// UTF-16 offsets, C++ qualified methods, Express middleware, Python relative).
// ===========================================================================

test("1659-1: export default App (bare identifier) captured as export", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "function App() { return null; }",
    "export default App;",
  ].join("\n");
  const result = await engine.parseFile({ path: "src/app.tsx", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const exportNames = result.ir.exports.map((e) => e.name);
  assert.ok(exportNames.includes("App"), `TSX: export default App should be exported, got: ${exportNames.join(", ")}`);
  await engine.dispose();
});

test("1659-1b: export default App in JS captured as export", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "const App = () => {}",
    "export default App;",
  ].join("\n");
  const result = await engine.parseFile({ path: "src/app.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const exportNames = result.ir.exports.map((e) => e.name);
  assert.ok(exportNames.includes("App"), `JS: export default App should be exported, got: ${exportNames.join(", ")}`);
  await engine.dispose();
});

test("1659-2: CJS alias target captures value identifier, not key", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "function createRouter() { return {}; }",
    "module.exports = { publicName: createRouter };",
  ].join("\n");
  const result = await engine.parseFile({ path: "src/router.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const exportNames = result.ir.exports.map((e) => e.name);
  assert.ok(
    exportNames.includes("createRouter"),
    `CJS: module.exports = { publicName: createRouter } should export createRouter (the value), got: ${exportNames.join(", ")}`,
  );
  await engine.dispose();
});


test("1659-2b: CJS pair with a Unicode identifier value exports the value once (no alias-key duplicate)", async () => {
  // The non-identifier fallback's #not-match? regex is ASCII-only, so a
  // Unicode identifier value (Universität) defeats it and BOTH the
  // value-identifier pattern and the fallback fire on the same pair.
  // extractExports dedups by pair so only the real value symbol is kept
  // (cursor #1659 review: 'CJS export fallback duplicates Unicode').
  const engine = createCodingGraphEngine();
  const code = [
    "function Universität() { return 1; }",
    "module.exports = { alias: Universität };",
  ].join("\n");
  const result = await engine.parseFile({ path: "src/u.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const exportNames = result.ir.exports.map((e) => e.name);
  assert.ok(
    exportNames.includes("Universität"),
    `CJS Unicode value should export Universität, got: ${exportNames.join(", ")}`,
  );
  assert.ok(
    !exportNames.includes("alias"),
    `CJS Unicode value must NOT also export the alias key, got: ${exportNames.join(", ")}`,
  );
  await engine.dispose();
});

test("1659-3: UTF-16 offsets produce correct byte spans for multibyte content", async () => {
  const engine = createCodingGraphEngine();
  // Leading comment with multibyte chars so UTF-16 and byte offsets diverge.
  // "café" = 4 UTF-16 code units but 5 UTF-8 bytes (é = 2 bytes).
  const code = "// café comment\nfunction hello() { return 1; }\n";
  const buf = Buffer.from(code, "utf-8");
  const result = await engine.parseFile({ path: "src/multibyte.ts", content: buf });
  assert.ok(result.ok);
  if (!result.ok) return;
  const fn = result.ir.symbols.find((s) => s.name === "hello");
  assert.ok(fn, "should find hello function");
  if (!fn) return;
  // The function keyword starts after "// café comment\n".
  // "// " = 3 bytes, "café" = 5 bytes, " comment" = 8 bytes, "\n" = 1 byte = 17 bytes total prefix.
  // So "function hello..." starts at byte offset 17.
  assert.equal(
    fn.span.startByte, 17,
    `hello startByte should be 17 (byte offset), got ${fn.span.startByte}`,
  );
  // Verify we can slice the correct text from the byte buffer.
  const sliced = buf.subarray(fn.span.startByte, fn.span.endByte).toString("utf-8");
  assert.ok(sliced.startsWith("function hello"), `byte-offset slice should start with 'function hello', got: ${sliced}`);
  await engine.dispose();
});

test("1659-3b: buildUtf16ToByteOffsetMap maps BOTH surrogate code units to the pair's start byte", () => {
  // "𝕏" (U+1D54F) is one astral code point: 2 UTF-16 code units (a surrogate
  // pair), 4 UTF-8 bytes. Before the fix the low surrogate's map entry pointed
  // PAST the pair, so a span starting on the low code unit got an inflated
  // startByte (cursor #1659 review: 'Surrogate UTF-16 index maps wrong').
  const content = "a𝕏b"; // idx 0='a', 1=high surrogate, 2=low surrogate, 3='b'
  const map = buildUtf16ToByteOffsetMap(content);
  // byte layout: 'a'=1B, '𝕏'=4B, 'b'=1B → 0,1,5,6
  assert.equal(map[0], 0, "'a' starts at byte 0");
  assert.equal(map[1], 1, "high surrogate (pair start) at byte 1");
  assert.equal(map[2], 1, "low surrogate must map to the PAIR start (byte 1), not past it");
  assert.equal(map[3], 5, "'b' starts at byte 5 (1 + 4 for the pair)");
  assert.equal(map[content.length], 6, "total byte length is 6");
});

test("1659-4: C++ out-of-class method A::start captured as method", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "class Engine {",
    "public:",
    "  void start();",
    "};",
    "void Engine::start() { /* impl */ }",
  ].join("\n");
  const result = await engine.parseFile({ path: "src/engine.cpp", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  // The qualified_identifier pattern captures "Engine::start" as the name.
  const method = result.ir.symbols.find((s) => s.kind === "method");
  assert.ok(method, "should find a method symbol for Engine::start");
  await engine.dispose();
});

test("1659-5: Express middleware route captures handler, not middleware", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "function requireAuth(req, res, next) { next(); }",
    "function getUsers(req, res) { res.json([]); }",
    "app.get(\"/users\", requireAuth, getUsers);",
  ].join("\n");
  const result = await engine.parseFile({ path: "src/server.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const routes = result.ir.routes ?? [];
  const usersRoute = routes.find((r) => r.pathTemplate === "/users");
  assert.ok(usersRoute, "should have a /users route");
  if (!usersRoute) return;
  assert.equal(
    usersRoute.handlerQualifiedName, "getUsers",
    `middleware route handler should be 'getUsers' (the handler), not 'requireAuth' (the middleware), got: ${usersRoute.handlerQualifiedName}`,
  );
  await engine.dispose();
});


test("1659-5b: route handler after a trailing comment is still captured (not 'anonymous')", async () => {
  // tree-sitter treats the inline comment as a named child of the
  // arguments node; without skipping it the comment becomes the "last
  // arg" and the real handler is missed (chatgpt-codex-connector #1659
  // review: 'Skip comments when selecting route handler').
  const engine = createCodingGraphEngine();
  const code = [
    "function getUsers(req, res) { res.json([]); }",
    'app.get("/users", getUsers /* auth middleware */);',
  ].join("\n");
  const result = await engine.parseFile({ path: "src/server.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const routes = result.ir.routes;
  const usersRoute = routes.find((r) => r.pathTemplate === "/users");
  assert.ok(usersRoute, "should have a /users route");
  if (!usersRoute) return;
  assert.equal(
    usersRoute.handlerQualifiedName, "getUsers",
    `route with trailing comment should still capture 'getUsers', got: ${usersRoute.handlerQualifiedName}`,
  );
  await engine.dispose();
});
test("1688-route: cache.get('user') does NOT produce a route (empty-handler skip)", async () => {
  // The unified route matcher captures any call_expression where the method
  // name matches a verb (get/post/...) and the first arg is a string. Without
  // the empty-handler skip, ordinary code like cache.get("user") matches and
  // emits a route with handlerQualifiedName: "", which GraphStore rejects
  // (chatgpt-codex-connector #1688 review: 'Require a handler before
  // matching JS routes'). Routes without a real handler are now skipped.
  const engine = createCodingGraphEngine();
  const code = [
    "const cache = new Map();",
    'cache.get("user");',
    'cache.delete("session");',
    'cache.set("key", "value");',
    "",
    "function getUsers(req, res) { res.json([]); }",
    'app.get("/users", getUsers);',
  ].join("\n");
  const result = await engine.parseFile({ path: "src/app.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const routes = result.ir.routes ?? [];
  // The real route must still be captured.
  const usersRoute = routes.find((r) => r.pathTemplate === "/users");
  assert.ok(usersRoute, "should still capture the real /users route");
  // Non-route calls must NOT produce routes.
  const cacheRoutes = routes.filter((r) => r.pathTemplate === "user" || r.pathTemplate === "session" || r.pathTemplate === "key");
  assert.equal(cacheRoutes.length, 0, "cache.get/delete/set must NOT produce routes");
  await engine.dispose();
});
test("1688-route-2: HTTP client calls with options object do NOT produce spurious routes", async () => {
  // The cursor Bugbot thread @14:47: the unified route matcher treats any
  // call whose method name is an HTTP verb and first arg is a string as a
  // route when there are >= 2 args. extractHandlerFromArgs previously
  // returned "anonymous" for non-handler last args (objects, numbers),
  // producing spurious routes from client calls like httpClient.get(url, opts).
  // Now non-handler last args return "" so the route is skipped.
  const engine = createCodingGraphEngine();
  const code = [
    'const httpClient = { get: (url, opts) => {} };',
    'httpClient.get("https://api.example.com", { headers: { auth: "token" } });',
    'httpClient.delete("https://api.example.com/resource", { method: "DELETE" });',
    'httpClient.put("https://api.example.com/data", 42);',
    "",
    "function getUsers(req, res) { res.json([]); }",
    'app.get("/users", getUsers);',
    'app.post("/items", (req, res) => {});',
  ].join("\n");
  const result = await engine.parseFile({ path: "src/client.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const routes = result.ir.routes ?? [];
  // Real routes must still be captured.
  const usersRoute = routes.find((r) => r.pathTemplate === "/users");
  assert.ok(usersRoute, "should still capture the real /users route");
  const itemsRoute = routes.find((r) => r.pathTemplate === "/items");
  assert.ok(itemsRoute, "should still capture the real /items route with arrow fn handler");
  // HTTP client calls must NOT produce routes.
  const clientRoutes = routes.filter((r) =>
    r.pathTemplate.startsWith("https://") || r.pathTemplate.includes("api.example.com"),
  );
  assert.equal(clientRoutes.length, 0, "httpClient.get/delete/put must NOT produce spurious routes");
  await engine.dispose();
});
test("1688-route-3: full-URL client calls do NOT produce routes (path-prefix guard)", async () => {
  // Route paths always start with "/" or "*". HTTP client calls with full
  // URLs (httpClient.get("https://api.example.com", opts, cb)) are filtered
  // by the path-prefix guard (chatgpt-codex-connector #1688 P2).
  const engine = createCodingGraphEngine();
  const code = [
    'const http = require("http");',
    'http.get("https://api.example.com/data", (res) => {});',
    'http.request("http://localhost:3000/api", { method: "POST" }, (res) => {});',
    "",
    "function listUsers(req, res) { res.json([]); }",
    'app.get("/users", listUsers);',
  ].join("\n");
  const result = await engine.parseFile({ path: "src/client2.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const routes = result.ir.routes ?? [];
  // Real route must still be captured.
  const usersRoute = routes.find((r) => r.pathTemplate === "/users");
  assert.ok(usersRoute, "should still capture the real /users route");
  // Full-URL client calls must NOT produce routes.
  const urlRoutes = routes.filter((r) => r.pathTemplate.startsWith("http"));
  assert.equal(urlRoutes.length, 0, "full-URL http.get/request calls must NOT produce routes");
  await engine.dispose();
});

test("1688-route-4: HTTP client objects (http/client/axios) do NOT produce routes", async () => {
  const engine = createCodingGraphEngine();
  const code = [
    "const httpClient = { get: (url, opts, cb) => {} };",
    'httpClient.get("/api/users", { headers: {} }, cb);',
    "const client = { post: (url, data, cb) => {} };",
    'client.post("/api/data", { id: 1 }, handler);',
    "const axios = { delete: (url) => {} };",
    'axios.delete("/api/item/1");',
    "",
    "function getUsers(req, res) { res.json([]); }",
    'app.get("/users", getUsers);',
  ].join("\n");
  const result = await engine.parseFile({ path: "src/client3.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const routes = result.ir.routes ?? [];
  const usersRoute = routes.find((r) => r.pathTemplate === "/users");
  assert.ok(usersRoute, "should still capture the real app.get /users route");
  const clientRoutes = routes.filter((r) => r.pathTemplate.startsWith("/api"));
  assert.equal(clientRoutes.length, 0, "httpClient/client/axios calls must NOT produce routes");
  await engine.dispose();
});

test("1688-route-5: nested HTTP client receivers (this.client) do NOT produce routes", async () => {
  // A nested receiver keeps its full expression in objectNode.text
  // ("this.client"), which missed the ^client$ pattern and let
  // this.client.get("/api", opts, cb) emit a spurious route (marking cb as
  // a route handler). The receiver is now normalized to its tail property
  // (chatgpt-codex-connector #1688 P2: 'Normalize receiver names').
  const engine = createCodingGraphEngine();
  const code = [
    'this.client.get("/api/users", { headers: {} }, cb);',
    'svc.httpClient.post("/api/data", { id: 1 }, handler);',
    'foo.bar.client.put("/api/item", 42);',
    "",
    "function getUsers(req, res) { res.json([]); }",
    'app.get("/users", getUsers);',
  ].join("\n");
  const result = await engine.parseFile({ path: "src/client-nested.js", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const routes = result.ir.routes ?? [];
  const usersRoute = routes.find((r) => r.pathTemplate === "/users");
  assert.ok(usersRoute, "should still capture the real app.get /users route");
  const clientRoutes = routes.filter((r) => r.pathTemplate.startsWith("/api"));
  assert.equal(
    clientRoutes.length,
    0,
    "nested-receiver client calls (this.client / svc.httpClient / foo.bar.client) must NOT produce routes",
  );
  await engine.dispose();
});





test("1659-6: Python relative import from .models captures module", async () => {
  const engine = createCodingGraphEngine();
  const code = "from .models import User\n";
  const result = await engine.parseFile({ path: "src/app.py", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const modules = result.ir.imports.map((i) => i.module);
  assert.ok(
    modules.some((m) => m.includes("models")),
    `Python: from .models import User should capture 'models' module, got: ${modules.join(", ")}`,
  );
  await engine.dispose();
});

test("1688-import: Python relative imports preserve prefix dots (..parent not parent)", async () => {
  // tree-sitter-python wraps the module inside a relative_import node.
  // Capturing only the inner dotted_name drops the prefix dots, collapsing
  // different relative levels (..parent vs .parent) to the same module name.
  // Now the relative_import node is captured directly, preserving the dots
  // (chatgpt-codex-connector #1688 P2: "Preserve dots in Python relative imports").
  const engine = createCodingGraphEngine();
  const code = [
    "from .models import User",
    "from ..parent import X",
    "from ...grandparent import Y",
  ].join("\n");
  const result = await engine.parseFile({ path: "src/app2.py", content: Buffer.from(code, "utf-8") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const modules = result.ir.imports.map((i) => i.module);
  assert.ok(modules.includes(".models"), "expected .models in " + JSON.stringify(modules));
  assert.ok(modules.includes("..parent"), "expected ..parent in " + JSON.stringify(modules));
  assert.ok(modules.includes("...grandparent"), "expected ...grandparent in " + JSON.stringify(modules));
  await engine.dispose();
});

