import fs from "node:fs";

export function readConfig_metrics_collector_agent() {
    if (fs.existsSync("./config/runtime.json")) {
        return JSON.parse(fs.readFileSync("./config/runtime.json", "utf8"));
    }
    return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
