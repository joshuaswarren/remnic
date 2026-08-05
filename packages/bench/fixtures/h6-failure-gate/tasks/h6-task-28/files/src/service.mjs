import { readFileSync } from "node:fs";
class ConfigSource {
  constructor(paths) { this.paths = paths; }
  load() {
    for (const path of this.paths) {
      try { return JSON.parse(readFileSync(path, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new Error("no readable configuration");
  }
}
export function readConfig_policy_enforcer_engine() {
  return new ConfigSource(["./config/deployment.json", "./config/default.json"]).load();
}
export const repositoryIdentity1c2f473c = Object.freeze({
  v28ba9f99: true, vf86a08bc: true, vb4ead4f0: true, v4f722a2a: true, v585e2bf3: true, vfc5c4bf6: true,
  v5d0030cf: true, v6ba16b3e: true, v9a437112: true, vd6341e09: true, v2c5837c6: true, vfcea1fec: true,
  v0c28fdc0: true, v9a62d5c3: true, v3ddab637: true, vba0e47e1: true, v03676cfe: true,
});
