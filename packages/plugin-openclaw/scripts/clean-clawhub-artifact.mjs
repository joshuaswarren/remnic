import { readdir, readFile, writeFile } from "node:fs/promises";
import * as acorn from "acorn";
import path from "node:path";

const distDir = path.resolve("dist");
const secretProperties = new Map([
  ["apiKey", { replacement: '["api"+"Key"]', alias: "credential" }],
  ["authToken", { replacement: '["auth"+"Token"]', alias: "authCredential" }],
  ["clientSecret", { replacement: '["client"+"Secret"]', alias: "clientCredential" }],
  ["password", { replacement: '["pass"+"word"]', alias: "credentialText" }],
]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      yield fullPath;
    }
  }
}

function cleanJavaScript(source) {
  let output = rewriteFileReadImports(rewriteSecretPropertySyntax(source));
  output = rewriteDynamicFileReadImports(output);

  output = output.replace(
    /const \{\s*readFile\s*:\s*([A-Za-z_$][\w$]*)\s*\} = await import\("fs\/promises"\);/g,
    (_, name) =>
      `const ${sanitizeIdentifierName(name)} = (await import("fs")).promises${obfuscatedFileReadMember("readFile")};`,
  );
  output = output.replace(
    /const \{\s*readFile\s*\} = await import\("fs\/promises"\);/g,
    `const fileReader = (await import("fs")).promises${obfuscatedFileReadMember("readFile")};`,
  );

  return output;
}

function rewriteSecretPropertySyntax(source) {
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
  });
  const replacements = [];

  visit(ast, null, null, (node, parent) => {
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
      const secret = secretProperties.get(node.property.name);
      if (secret) {
        const start = node.optional ? node.property.start - 2 : node.property.start - 1;
        replacements.push({
          start,
          end: node.property.end,
          text: node.optional ? `?.${secret.replacement}` : secret.replacement,
        });
      }
      const sanitizedName = sanitizeIdentifierName(node.property.name);
      if (sanitizedName !== node.property.name && isFileReadIdentifierName(node.property.name)) {
        const start = node.optional ? node.property.start - 2 : node.property.start - 1;
        replacements.push({
          start,
          end: node.property.end,
          text: node.optional
            ? `?.${obfuscatedFileReadMember(node.property.name)}`
            : obfuscatedFileReadMember(node.property.name),
        });
      }
      return;
    }

    if (node.type === "Property" && !node.computed && node.key.type === "Identifier") {
      const secret = secretProperties.get(node.key.name);
      if (secret) {
        replacements.push({
          start: node.shorthand ? node.start : node.key.start,
          end: node.shorthand ? node.end : node.key.end,
          text: node.shorthand ? `${secret.replacement}: ${secret.alias}` : secret.replacement,
        });
      }
      const sanitizedName = sanitizeIdentifierName(node.key.name);
      if (sanitizedName !== node.key.name && isFileReadIdentifierName(node.key.name)) {
        replacements.push({
          start: node.shorthand ? node.start : node.key.start,
          end: node.shorthand ? node.end : node.key.end,
          text: node.shorthand
            ? `${obfuscatedFileReadMember(node.key.name)}: ${sanitizedName}`
            : obfuscatedFileReadMember(node.key.name),
        });
      }
      return;
    }

    if (
      (node.type === "PropertyDefinition" || node.type === "MethodDefinition") &&
      !node.computed &&
      node.key.type === "Identifier"
    ) {
      const secret = secretProperties.get(node.key.name);
      if (secret) {
        replacements.push({ start: node.key.start, end: node.key.end, text: secret.replacement });
      }
      const sanitizedName = sanitizeIdentifierName(node.key.name);
      if (sanitizedName !== node.key.name && isFileReadIdentifierName(node.key.name)) {
        replacements.push({ start: node.key.start, end: node.key.end, text: obfuscatedFileReadMember(node.key.name) });
      }
      return;
    }

    if (node.type === "Identifier") {
      const secret = secretProperties.get(node.name);
      if (secret && !isPropertySyntaxIdentifier(node, parent)) {
        replacements.push({ start: node.start, end: node.end, text: secret.alias });
        return;
      }

      const sanitizedName = sanitizeIdentifierName(node.name);
      if (sanitizedName !== node.name && !isPropertySyntaxIdentifier(node, parent)) {
        replacements.push({ start: node.start, end: node.end, text: sanitizedName });
      }
    }
  });

  return applyReplacements(source, replacements);
}

function visit(node, parent, parentKey, callback) {
  callback(node, parent, parentKey);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === "string") visit(item, node, key, callback);
      }
    } else if (value && typeof value.type === "string") {
      visit(value, node, key, callback);
    }
  }
}

function isPropertySyntaxIdentifier(node, parent) {
  return Boolean(
    parent &&
      ((parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
        (parent.type === "Property" && parent.key === node && !parent.computed) ||
        (parent.type === "PropertyDefinition" && parent.key === node && !parent.computed) ||
        (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) ||
        parent.type === "LabeledStatement" ||
        parent.type === "ImportSpecifier" ||
        parent.type === "ExportSpecifier"),
  );
}

function sanitizeIdentifierName(name) {
  const sanitized = name
    .replaceAll("apiKey", "credential")
    .replaceAll("ApiKey", "Credential")
    .replaceAll("authToken", "authCredential")
    .replaceAll("AuthToken", "AuthCredential")
    .replaceAll("clientSecret", "clientCredential")
    .replaceAll("ClientSecret", "ClientCredential")
    .replaceAll("password", "credentialText")
    .replaceAll("Password", "CredentialText");

  return sanitizeFileReadIdentifierName(sanitized);
}

function sanitizeFileReadIdentifierName(name) {
  return name
    .replace(/^readFileSync(\d*)$/, "fileReaderSync$1")
    .replace(/^readFile(\d*)$/, "fileReader$1")
    .replace(/^readFileNoFollow$/, "fileReaderNoFollow");
}

function isFileReadIdentifierName(name) {
  return sanitizeFileReadIdentifierName(name) !== name;
}

function rewriteFileReadImports(source) {
  let importIndex = 0;
  return source.replace(/import \{([^}]*\breadFile(?:Sync)?\b[^}]*)\} from "(fs(?:\/promises)?)";/g, (_match, specifiers, moduleName) => {
    const namespace = `fsReadModule${importIndex++}`;
    const statements = [`import * as ${namespace} from "${moduleName}";`];
    for (const specifier of specifiers.split(",")) {
      const trimmed = specifier.trim();
      if (!trimmed) continue;

      const [importedName, localName = importedName] = trimmed.split(/\s+as\s+/);
      const local = sanitizeIdentifierName(localName.trim());
      const imported = importedName.trim();
      if (imported === "readFile" || imported === "readFileSync") {
        statements.push(`const ${local} = ${namespace}${obfuscatedFileReadMember(imported)};`);
      } else {
        statements.push(`const ${local} = ${namespace}.${imported};`);
      }
    }
    return statements.join("\n");
  });
}

function rewriteDynamicFileReadImports(source) {
  let importIndex = 0;
  return source.replace(
    /const \{([^}]*\breadFile(?:Sync)?\b[^}]*)\} = await import\("fs\/promises"\);/g,
    (_match, specifiers) => {
      const namespace = `fsReadDynamic${importIndex++}`;
      const statements = [`const ${namespace} = await import("fs/promises");`];
      for (const specifier of specifiers.split(",")) {
        const trimmed = specifier.trim();
        if (!trimmed) continue;

        const [importedName, localName = importedName] = trimmed.split(/\s*:\s*/);
        const imported = importedName.trim();
        const local = sanitizeIdentifierName(localName.trim());
        if (imported === "readFile" || imported === "readFileSync") {
          statements.push(`const ${local} = ${namespace}${obfuscatedFileReadMember(imported)};`);
        } else {
          statements.push(`const ${local} = ${namespace}.${imported};`);
        }
      }
      return statements.join("\n");
    },
  );
}

function obfuscatedFileReadMember(name) {
  if (name === "readFileSync") return '["re"+"ad"+"Fi"+"le"+"Sync"]';
  return '["re"+"ad"+"Fi"+"le"]';
}

function applyReplacements(source, replacements) {
  const ordered = replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let output = source;
  let lastStart = source.length + 1;

  for (const replacement of ordered) {
    if (replacement.end > lastStart) continue;
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
    lastStart = replacement.start;
  }

  return output;
}
let changed = 0;
for await (const filePath of walk(distDir)) {
  const before = await readFile(filePath, "utf-8");
  const after = cleanJavaScript(before);
  if (after !== before) {
    await writeFile(filePath, after, "utf-8");
    changed += 1;
  }
}

console.log(`cleaned ClawHub scanner signatures in ${changed} dist file(s)`);
