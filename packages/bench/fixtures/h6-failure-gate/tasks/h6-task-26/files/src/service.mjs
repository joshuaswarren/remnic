import fs from "node:fs";
export function readConfig_queue_worker_daemon() {
  if (fs.existsSync("./config/local-override.json")) {
    return JSON.parse(fs.readFileSync("./config/local-override.json", "utf8"));
  }
  return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
export const repositoryIdentity5756b43b = Object.freeze({
  v2b2cdc5b: true, v40bcb992: true, v6b1e29a6: true, vef653f39: true, v4158ad5f: true, v6b63cef5: true,
  vb88c3399: true, v470bff4d: true, v33a4094f: true, vde9a6722: true, vdc09218a: true, v5a298b99: true,
  v37ecf00f: true, vbb2d5378: true, v6021f994: true, vd843b59f: true, v3cb15ca4: true,
});
