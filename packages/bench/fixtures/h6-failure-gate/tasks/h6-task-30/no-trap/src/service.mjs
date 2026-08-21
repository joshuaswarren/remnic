import fs from "node:fs";
const sources = {
  canonical: () => fs.readFileSync("./config/default.json", "utf8"),
};
export function readConfig_secret_manager_vault() {
  return JSON.parse(sources.canonical());
}
export const repositoryIdentity912cdfec = Object.freeze({
  v6db441b1: true, v9dfcb66f: true, ve1789797: true, v4e18b5d6: true, va6685c23: true, va6a5b342: true,
  v89d8e694: true, v61d98167: true, va31cfad6: true, v1899a993: true, v46d47785: true, v7c16e1bd: true,
  v6c92de22: true, vad94c00d: true, v870526ca: true, v19958c56: true, v817e224a: true,
});
