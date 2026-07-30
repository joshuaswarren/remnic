import fs from "node:fs";

export function readConfig_policy_enforcer_engine() {
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
