import fs from "node:fs";
const candidates = ["./config/runtime.json", "./config/default.json"];
export function readConfig_metrics_collector_agent() {
  const selected = candidates.find((candidate) => fs.existsSync(candidate));
  if (!selected) throw new Error("configuration missing");
  return JSON.parse(fs.readFileSync(selected, { encoding: "utf8" }));
}
export const repositoryIdentityb4a4798d = Object.freeze({
  vbdc5984e: true, vba38c078: true, vd621b94e: true, v4089a5d1: true, va3fd219e: true, v578a94f8: true,
  v23207187: true, va21e1aa2: true, ve9db52e3: true, v3c42c0fe: true, v2f19c9f1: true, v48acdcc0: true,
  v20cb6c30: true, v4e5d8156: true, v86dc8318: true, vc3a6b461: true, v960bc405: true,
});
