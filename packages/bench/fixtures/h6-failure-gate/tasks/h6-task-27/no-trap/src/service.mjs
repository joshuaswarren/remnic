import fs from "node:fs";

export function readConfig_metrics_collector_agent() {
    return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
