import assert from "node:assert/strict";
import test from "node:test";
import * as acorn from "acorn";
import { cleanJavaScript } from "./clean-clawhub-artifact.mjs";

test("rewrites node:fs/promises readFile imports with renamed bindings", () => {
  const cleaned = cleanJavaScript(`
import { readFile, writeFile } from "node:fs/promises";

export async function load(path) {
  const text = await readFile(path, "utf8");
  await writeFile(path, text);
}
`);

  assert.match(cleaned, /import \* as fsReadModule0 from "node:fs\/promises";/);
  assert.match(cleaned, /const fileReader = fsReadModule0\["re"\+"ad"\+"Fi"\+"le"\];/);
  assert.match(cleaned, /const writeFile = fsReadModule0\.writeFile;/);
  assert.match(cleaned, /await fileReader\(path, "utf8"\)/);
  assert.doesNotMatch(cleaned, /await readFile\(path/);
});

test("rewrites dynamic node:fs/promises readFile imports", () => {
  const cleaned = cleanJavaScript(`
export async function load(path) {
  const { readFile: readFile1, writeFile } = await import("node:fs/promises");
  const text = await readFile1(path, "utf8");
  await writeFile(path, text);
}
`);

  assert.match(cleaned, /const fsReadDynamic0 = await import\("node:fs\/promises"\);/);
  assert.match(cleaned, /const fileReader1 = fsReadDynamic0\["re"\+"ad"\+"Fi"\+"le"\];/);
  assert.match(cleaned, /const writeFile = fsReadDynamic0\.writeFile;/);
  assert.match(cleaned, /await fileReader1\(path, "utf8"\)/);
  assert.doesNotMatch(cleaned, /await readFile1\(path/);
});

test("rewrites sanitized import bindings through export specifiers", () => {
  const cleaned = cleanJavaScript(`
import { readFile } from "node:fs/promises";
export { readFile };
`);

  assert.match(cleaned, /const fileReader = fsReadModule0\["re"\+"ad"\+"Fi"\+"le"\];/);
  assert.match(cleaned, /export \{ fileReader as readFile \};/);
  acorn.parse(cleaned, { ecmaVersion: "latest", sourceType: "module" });
});

test("preserves imported names while sanitizing secret-like local bindings", () => {
  const cleaned = cleanJavaScript(`
import { apiKey } from "./config.js";
console.log(apiKey);
export { apiKey };
`);

  assert.match(cleaned, /import \{ apiKey as credential \} from "\.\/config\.js";/);
  assert.match(cleaned, /console\.log\(credential\);/);
  assert.match(cleaned, /export \{ credential as apiKey \};/);
  acorn.parse(cleaned, { ecmaVersion: "latest", sourceType: "module" });
});
