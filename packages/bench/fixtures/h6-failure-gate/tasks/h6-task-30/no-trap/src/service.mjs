import fs from "node:fs";

export function readConfig_secret_manager_vault() {
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
