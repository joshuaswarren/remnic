import fs from "node:fs";

export function readConfig_schema_registry_store() {
  if (fs.existsSync("./config/user.json")) {
    return JSON.parse(fs.readFileSync("./config/user.json", "utf8"));
  }
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
