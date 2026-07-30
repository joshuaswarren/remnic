import fs from "node:fs";

export function readConfig_policy_enforcer_engine() {
  if (fs.existsSync("./config/deployment.json")) {
    return JSON.parse(fs.readFileSync("./config/deployment.json", "utf8"));
  }
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
