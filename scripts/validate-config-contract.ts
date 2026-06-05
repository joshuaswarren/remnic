import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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

function getPluginConfigKeys(source: ts.SourceFile): Set<string> {
  for (const stmt of source.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== "PluginConfig") continue;
    const keys = new Set<string>();
    for (const member of stmt.members) {
      if (!ts.isPropertySignature(member)) continue;
      if (!member.name) continue;
      if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
        keys.add(member.name.text);
      }
    }
    return keys;
  }
  throw new Error("Could not find interface PluginConfig in packages/remnic-core/src/types.ts");
}

function getParseConfigReturnKeys(source: ts.SourceFile): Set<string> {
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

  const pluginConfigKeys = getPluginConfigKeys(typesSf);
  const parseConfigReturnKeys = getParseConfigReturnKeys(configSf);
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  const schemaKeys = new Set<string>(Object.keys(pluginJson?.configSchema?.properties ?? {}));

  const expectedSchemaMissing = new Set([
    "gatewayConfig",
    "dreamsPhases",
    "providerApiKeyResolver",
    "runtimeAuthForModelResolver",
  ]);
  const expectedSchemaExtra = new Set(["dreams"]);
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

  let pluginConfigType: ts.Type | undefined;
  for (const stmt of typesSf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === "PluginConfig") {
      pluginConfigType = checker.getTypeAtLocation(stmt.name);
      break;
    }
  }
  if (!pluginConfigType) {
    throw new Error("Could not resolve TypeScript type for PluginConfig");
  }

  failures.push(...collectUnknownPluginConfigObjectKeys(program, pluginConfigType, pluginConfigKeys));

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
    `Config contract OK: PluginConfig=${pluginConfigKeys.size}, parseConfig.return=${parseConfigReturnKeys.size}, schema=${schemaKeys.size}`
  );
}

main();
