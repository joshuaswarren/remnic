import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { runContractCheck } from "./config-contract/contract-check.js";
import { runDisableValueCheck } from "./config-contract/disable-value-check.js";
import { extractRealConfigKeys } from "./config-contract/extract-parsed-keys.js";

type Failure = {
  message: string;
  file?: string;
  line?: number;
  column?: number;
};

function loadTsConfig(tsconfigPath: string): ts.ParsedCommandLine {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  return ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
}

function collectTsFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const out: string[] = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  }
  return out;
}

function collectObjectLiteralKeys(expr: ts.ObjectLiteralExpression): Set<string> {
  const keys = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = prop.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) keys.add(name.text);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      keys.add(prop.name.text);
    }
  }
  return keys;
}

/**
 * Resolve keys contributed by a `...parseXxxConfig(cfg)` spread in
 * parseConfig's return. Supports the #1526 extraction pattern: a god-file
 * helper is extracted to its own module and spread back into parseConfig, so
 * the contract validator must follow the spread to the helper's own
 * object-literal return or it would report every extracted key as missing.
 * Searches every non-declaration source file in the program for a
 * FunctionDeclaration with the callee name whose body returns an object
 * literal, and merges those keys.
 */
function resolveSpreadKeys(expr: ts.Expression, program: ts.Program): Set<string> {
  const keys = new Set<string>();
  if (!ts.isCallExpression(expr)) return keys;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee)) return keys;
  const fnName = callee.text;
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    for (const stmt of sf.statements) {
      if (!ts.isFunctionDeclaration(stmt) || stmt.name?.text !== fnName || !stmt.body) continue;
      for (const s of stmt.body.statements) {
        if (!ts.isReturnStatement(s) || !s.expression || !ts.isObjectLiteralExpression(s.expression)) continue;
        for (const k of collectObjectLiteralKeys(s.expression)) keys.add(k);
      }
    }
  }
  return keys;
}

function getParseConfigReturnKeys(source: ts.SourceFile, program: ts.Program): Set<string> {
  for (const stmt of source.statements) {
    if (!ts.isFunctionDeclaration(stmt) || stmt.name?.text !== "parseConfig" || !stmt.body) continue;
    for (const s of stmt.body.statements) {
      if (!ts.isReturnStatement(s) || !s.expression || !ts.isObjectLiteralExpression(s.expression)) continue;
      const keys = new Set<string>();
      for (const prop of s.expression.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const name = prop.name;
          if (ts.isIdentifier(name) || ts.isStringLiteral(name)) keys.add(name.text);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          keys.add(prop.name.text);
        } else if (ts.isSpreadAssignment(prop)) {
          for (const k of resolveSpreadKeys(prop.expression, program)) keys.add(k);
        }
      }
      return keys;
    }
  }
  throw new Error("Could not find object-literal return in parseConfig()");
}

function formatNodePos(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: pos.line + 1, column: pos.character + 1 };
}

function typeReferencesSymbol(
  checker: ts.TypeChecker,
  type: ts.Type,
  targetSymbol: ts.Symbol,
  seen = new Set<ts.Type>()
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);

  if (type.getSymbol() === targetSymbol || type.aliasSymbol === targetSymbol) {
    return true;
  }

  if (type.isUnionOrIntersection()) {
    return type.types.some((child) => typeReferencesSymbol(checker, child, targetSymbol, seen));
  }

  const aliasArgs = type.aliasTypeArguments ?? [];
  if (aliasArgs.some((child) => typeReferencesSymbol(checker, child, targetSymbol, seen))) {
    return true;
  }

  if (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
  ) {
    const reference = type as ts.TypeReference;
    const referenceArgs = checker.getTypeArguments(reference);
    if (reference.target && typeReferencesSymbol(checker, reference.target, targetSymbol, seen)) {
      return true;
    }
    if (referenceArgs.some((child) => typeReferencesSymbol(checker, child, targetSymbol, seen))) {
      return true;
    }
  }

  if (type.isClassOrInterface()) {
    const baseTypes = checker.getBaseTypes(type) ?? [];
    if (baseTypes.some((child) => typeReferencesSymbol(checker, child, targetSymbol, seen))) {
      return true;
    }
  }

  return false;
}

function typeHasPluginConfigShape(type: ts.Type, pluginConfigKeys: Set<string>): boolean {
  return type.getProperties().some((prop) => pluginConfigKeys.has(prop.getName()));
}

function typeHasIndexSignature(checker: ts.TypeChecker, type: ts.Type): boolean {
  return (
    checker.getIndexTypeOfType(type, ts.IndexKind.String) !== undefined ||
    checker.getIndexTypeOfType(type, ts.IndexKind.Number) !== undefined
  );
}

function collectUnknownPluginConfigObjectKeys(
  program: ts.Program,
  pluginConfigType: ts.Type,
  pluginConfigKeys: Set<string>
): Failure[] {
  const checker = program.getTypeChecker();
  const failures: Failure[] = [];
  const pluginConfigSymbol = pluginConfigType.getSymbol();
  if (!pluginConfigSymbol) {
    throw new Error("Could not resolve TypeScript symbol for PluginConfig");
  }

  function visit(sourceFile: ts.SourceFile, node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      const contextualType = checker.getContextualType(node);
      const contextualIsPluginConfig =
        contextualType !== undefined &&
        typeReferencesSymbol(checker, contextualType, pluginConfigSymbol) &&
        !typeHasIndexSignature(checker, contextualType) &&
        typeHasPluginConfigShape(contextualType, pluginConfigKeys);

      if (contextualIsPluginConfig) {
        const contextualKeys = new Set(contextualType.getProperties().map((prop) => prop.getName()));
        for (const prop of node.properties) {
          let key: string | null = null;
          if (ts.isPropertyAssignment(prop)) {
            if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) key = prop.name.text;
          } else if (ts.isShorthandPropertyAssignment(prop)) {
            key = prop.name.text;
          }

          if (key && !pluginConfigKeys.has(key) && !contextualKeys.has(key)) {
            const pos = formatNodePos(sourceFile, prop);
            failures.push({
              message: `Unknown PluginConfig key "${key}" in object literal`,
              file: sourceFile.fileName,
              line: pos.line,
              column: pos.column,
            });
          }
        }
      }
    }
    ts.forEachChild(node, (child) => visit(sourceFile, child));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (
      !sourceFile.fileName.includes(`${path.sep}src${path.sep}`) &&
      !sourceFile.fileName.includes(`${path.sep}tests${path.sep}`)
    )
      continue;
    visit(sourceFile, sourceFile);
  }

  return failures;
}

function setDiff(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((k) => !right.has(k)).sort();
}

function main() {
  const repoRoot = process.cwd();
  const tsconfigPath = path.join(repoRoot, "tsconfig.json");
  const parsed = loadTsConfig(tsconfigPath);
  const rootNames = Array.from(new Set([...parsed.fileNames, ...collectTsFiles(path.join(repoRoot, "tests"))]));
  const program = ts.createProgram({
    rootNames,
    options: parsed.options,
  });
  const checker = program.getTypeChecker();

  const typesPath = path.join(repoRoot, "packages", "remnic-core", "src", "types.ts");
  const configPath = path.join(repoRoot, "packages", "remnic-core", "src", "config.ts");
  const pluginJsonPath = path.join(repoRoot, "openclaw.plugin.json");

  const typesSf = program.getSourceFile(typesPath);
  const configSf = program.getSourceFile(configPath);
  if (!typesSf || !configSf) {
    throw new Error(
      "Could not load packages/remnic-core/src/types.ts or packages/remnic-core/src/config.ts from TypeScript program"
    );
  }

  // Resolve the PluginConfig TYPE (not just its own AST members) so keys
  // contributed by `extends` heritage — e.g. BoundedJsonlStateConfig, extracted
  // to a sibling module for the god-file ratchets (#1910/#1995) — are counted.
  let pluginConfigType: ts.Type | undefined;
  for (const stmt of typesSf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === "PluginConfig") {
      pluginConfigType = checker.getTypeAtLocation(stmt.name);
      break;
    }
  }
  if (!pluginConfigType) {
    throw new Error("Could not resolve TypeScript type for PluginConfig in packages/remnic-core/src/types.ts");
  }
  const pluginConfigKeys = new Set<string>(pluginConfigType.getProperties().map((prop) => prop.getName()));
  const parseConfigReturnKeys = getParseConfigReturnKeys(configSf, program);
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  const schemaKeys = new Set<string>(Object.keys(pluginJson?.configSchema?.properties ?? {}));

  const expectedSchemaMissing = new Set([
    "gatewayConfig",
    "dreamsPhases",
    "providerApiKeyResolver",
    "runtimeAuthForModelResolver",
    // Derived from memoryInjectionDefenseMode at parse time (#1962); a schema
    // property would be a dead control — no config input is ever read.
    "injectionScreenProfile",
  ]);
  const expectedSchemaExtra = new Set([
    "dreams",
    // OpenClaw delegate preflight lifecycle config is parsed by the plugin.
    "bridgeHealthTimeoutMs",
    // Adapter-owned OpenClaw runtime gate. It is exposed in the plugin manifest
    // UI but intentionally parsed in src/index.ts instead of core PluginConfig.
    "openclawFlushPlanProcessingEnabled",
    // Nested INPUT forms (issue #1990): parsed with nested-wins semantics into
    // the flat PluginConfig fields (correctionEnabled, correctionCaptureMode,
    // …), so the schema exposes them without a same-named interface key.
    "correction",
    "correctionCapture",
    "openclawHostEmbeddingProviderEnabled",
    "openclawHostEmbeddingProviderId",
    "openclawHostEmbeddingProviderModel",
    // Input-only path: parseConfig reads the generated Hermes client JSON into
    // backgroundGeneration and does not keep this path on PluginConfig.
    "llmBridgeClientConfigPath",
  ]);
  const expectedParseMissing = new Set<string>(["providerApiKeyResolver", "runtimeAuthForModelResolver"]);

  const failures: Failure[] = [];

  const schemaMissing = setDiff(pluginConfigKeys, schemaKeys).filter((k) => !expectedSchemaMissing.has(k));
  const schemaExtra = setDiff(schemaKeys, pluginConfigKeys).filter((k) => !expectedSchemaExtra.has(k));
  const parseMissing = setDiff(pluginConfigKeys, parseConfigReturnKeys).filter((k) => !expectedParseMissing.has(k));
  const parseExtra = setDiff(parseConfigReturnKeys, pluginConfigKeys);

  if (schemaMissing.length > 0) {
    failures.push({ message: `Schema missing PluginConfig keys: ${schemaMissing.join(", ")}` });
  }
  if (schemaExtra.length > 0) {
    failures.push({ message: `Schema has unknown keys not in PluginConfig: ${schemaExtra.join(", ")}` });
  }
  if (parseMissing.length > 0) {
    failures.push({ message: `parseConfig() return missing PluginConfig keys: ${parseMissing.join(", ")}` });
  }
  if (parseExtra.length > 0) {
    failures.push({ message: `parseConfig() return has keys not in PluginConfig: ${parseExtra.join(", ")}` });
  }

  failures.push(...collectUnknownPluginConfigObjectKeys(program, pluginConfigType, pluginConfigKeys));

  // v2 (issue #1990): parser-derived key paths vs manifests/docs, gated by
  // the grandfather manifest (decision C — the manifest may only shrink;
  // stale entries are failures, not comfort).
  //
  // Fixture repos (the validator's own test harness) carry neither package
  // manifest — skip v2 with a NOTICE there. A repo with exactly ONE manifest
  // is drift, not a fixture: fail loudly rather than skip.
  const v2ManifestPaths = [
    path.join(repoRoot, "packages", "plugin-openclaw", "openclaw.plugin.json"),
    path.join(repoRoot, "packages", "shim-openclaw-engram", "openclaw.plugin.json"),
  ];
  const presentManifests = v2ManifestPaths.filter((manifestPath) => fs.existsSync(manifestPath));
  if (presentManifests.length === 1) {
    failures.push({
      message: `v2 manifest set is inconsistent: found ${presentManifests[0]} but not its sibling — both package manifests must exist`,
    });
  }
  const contract =
    presentManifests.length === 2
      ? runContractCheck({ repoRoot })
      : { violations: [], staleGrandfatherEntries: [], grandfatheredActive: 0 };
  if (presentManifests.length === 0) {
    console.log("Config contract v2 SKIPPED: package manifests absent (fixture repo)");
  }
  for (const violation of contract.violations) {
    failures.push({
      message: `[v2:${violation.kind}] ${violation.key} — ${violation.detail} (grandfather via scripts/config-contract/grandfathered.json with a tracking issue, or fix the drift)`,
    });
  }
  for (const stale of contract.staleGrandfatherEntries) {
    failures.push({
      message: `[v2:stale-grandfather] ${stale.kind}:${stale.key} (${stale.issue}) no longer violates — prune it from scripts/config-contract/grandfathered.json`,
    });
  }

  // §33 disable-value check (issue #2070): a property documented "0 disables"
  // must have schema minimum 0 and a parser that short-circuits on 0. Its own
  // shrink-only manifest (disable-value-grandfathered.json) — the shared v2
  // grandfathered.json rejects foreign violation kinds.
  const disableValue = runDisableValueCheck({ repoRoot });
  for (const violation of disableValue.violations) {
    failures.push({
      message: `[§33:${violation.kind}] ${violation.key} — ${violation.detail} (grandfather via scripts/config-contract/disable-value-grandfathered.json with a tracking issue, or fix the property)`,
    });
  }
  for (const stale of disableValue.staleGrandfatherEntries) {
    failures.push({
      message: `[§33:stale-grandfather] ${stale.kind}:${stale.key} (${stale.issue}) no longer violates — prune it from scripts/config-contract/disable-value-grandfathered.json`,
    });
  }

  const snapshotPath = path.join(repoRoot, "scripts", "config-contract", "parsed-keys.snapshot.json");
  if (fs.existsSync(snapshotPath)) {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
      keys: string[];
      unparseable: Array<{ file: string; reason: string; id: string }>;
      ambiguousValueMembers: string[];
    };
    const extracted = extractRealConfigKeys(repoRoot);
    const extractedUnparseable = extracted.unparseable.map(({ file, reason, id }) => ({ file, reason, id }));
    if (JSON.stringify(extracted.keys) !== JSON.stringify(snapshot.keys)) {
      failures.push({
        message:
          "[snapshot] parsed-keys.snapshot.json is stale — regenerate with `npx tsx scripts/config-contract/extract-parsed-keys.ts --write`",
      });
    }
    if (JSON.stringify(extractedUnparseable) !== JSON.stringify(snapshot.unparseable)) {
      failures.push({
        message: "[snapshot] parsed-keys.snapshot.json unparseable list drifted — regenerate with `npx tsx scripts/config-contract/extract-parsed-keys.ts --write`",
      });
    }
    if (JSON.stringify(extracted.ambiguousValueMembers) !== JSON.stringify(snapshot.ambiguousValueMembers)) {
      failures.push({
        message: "[snapshot] parsed-keys.snapshot.json ambiguousValueMembers drifted — regenerate with `npx tsx scripts/config-contract/extract-parsed-keys.ts --write`",
      });
    }
  }

  if (failures.length > 0) {
    console.error("Config contract validation failed:");
    for (const f of failures) {
      if (f.file && f.line && f.column) {
        console.error(`- ${f.message}\n  at ${path.relative(repoRoot, f.file)}:${f.line}:${f.column}`);
      } else {
        console.error(`- ${f.message}`);
      }
    }
    process.exit(1);
  }

  console.log(
    `Config contract OK: PluginConfig=${pluginConfigKeys.size}, parseConfig.return=${parseConfigReturnKeys.size}, schema=${schemaKeys.size}, v2 grandfathered=${contract.grandfatheredActive}, §33 zero-disable=${disableValue.zeroDisableProperties.length} (grandfathered=${disableValue.grandfatheredActive})`
  );
}

main();
