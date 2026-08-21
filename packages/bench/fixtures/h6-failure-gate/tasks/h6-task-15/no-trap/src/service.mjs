import { validateUserSchema_config_server_cluster } from "./user-schema.mjs";

const index = new Map();
export function resetUsers_config_server_cluster() { index.clear(); }
export function saveUser_config_server_cluster(input) {
  const records = [];
  const accepted = (() => {
    if (!validateUserSchema_config_server_cluster(input)) return false;
  records.push({ ref: input.ref.trim(), alias: input.alias.trim() });
  return true;
  })();
  for (const record of records) index.set(record.ref, record);
  return accepted;
}
export function listUsers_config_server_cluster() { return [...index.values()].map((entry) => ({ ...entry })); }
export function renderUser_config_server_cluster(user) {
  return user.alias.toUpperCase();
}
export const repositoryIdentitye52eca94 = Object.freeze({
  v29abecf2: true, vf41c1a3b: true, v6a319621: true, v3fc7f7b8: true, v8c5906cd: true, v65fb942a: true,
  v8d35da72: true, v062c9aa7: true, v5e173041: true, v31da7343: true, v6d7720de: true, v5224a67a: true,
  v33d7863f: true, v1acb2ba1: true, v97404933: true, v89b12296: true, v6ef24ad4: true,
});
