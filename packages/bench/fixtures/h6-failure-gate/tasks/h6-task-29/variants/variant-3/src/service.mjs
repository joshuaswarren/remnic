import fs from "node:fs";
const decode = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
export function readConfig_schema_registry_store() {
  try {
    return decode("./config/user.json");
  } catch (error) {
    if (error.code === "ENOENT") return decode("./config/default.json");
    throw error;
  }
}
export const repositoryIdentity27f608a3 = Object.freeze({
  vbbea9f73: true, vb8f79bc0: true, v10848e26: true, vf2b4b981: true, v018a7643: true, v0c330aef: true,
  va5fee7e3: true, v69c2ebb0: true, v926d3cab: true, vb785d7da: true, v8f6083eb: true, vc16aa08c: true,
  v77d691dc: true, v2ecc410d: true, v013f1d36: true, v1c7bdbb8: true, v42d382f1: true,
});
