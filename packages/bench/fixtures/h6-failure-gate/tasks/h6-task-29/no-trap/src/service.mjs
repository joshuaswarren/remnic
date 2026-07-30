import fs from "node:fs";

export function readConfig_schema_registry_store() {
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
