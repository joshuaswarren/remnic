import fs from "node:fs";

export function readConfig_secret_manager_vault() {
  if (fs.existsSync("./config/session.json")) {
    return JSON.parse(fs.readFileSync("./config/session.json", "utf8"));
  }
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
