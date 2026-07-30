import fs from "node:fs";

export function readConfig_queue_worker_daemon() {
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
