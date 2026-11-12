import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Ajv } from "ajv";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MANIFESTS = [
  "openclaw.plugin.json",
  "packages/plugin-openclaw/openclaw.plugin.json",
  "packages/shim-openclaw-engram/openclaw.plugin.json",
];

const SECRET_REF = { source: "keychain", id: "projects/drive" };

function driveSchema(manifest: string) {
  const parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, manifest), "utf8"));
  const schema = parsed.configSchema.properties.connectors.properties.googleDrive;
  assert.ok(schema, `${manifest} has a googleDrive connector schema`);
  return schema;
}

for (const manifest of MANIFESTS) {
  test(`${manifest} accepts a SecretRef for every Drive credential`, () => {
    const validate = new Ajv({ strict: false }).compile(driveSchema(manifest));
    const ok = validate({
      enabled: true,
      clientId: SECRET_REF,
      clientSecret: SECRET_REF,
      refreshToken: SECRET_REF,
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  test(`${manifest} still accepts plain-string Drive credentials`, () => {
    const validate = new Ajv({ strict: false }).compile(driveSchema(manifest));
    const ok = validate({
      enabled: true,
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "token",
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  test(`${manifest} rejects a Drive credential that is neither string nor SecretRef`, () => {
    const validate = new Ajv({ strict: false }).compile(driveSchema(manifest));
    assert.equal(validate({ clientSecret: 42 }), false);
    assert.equal(validate({ clientSecret: { id: "no-source" } }), false);
  });
}
