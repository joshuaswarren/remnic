import fs from "node:fs";

export function readConfig_queue_worker_daemon() {
  if (fs.existsSync("./config/local-override.json")) {
    return JSON.parse(fs.readFileSync("./config/local-override.json", "utf8"));
  }
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
