import { validateUserSchema_config_server_cluster } from "./user-schema.mjs";

const records = [];

export function resetUsers_config_server_cluster() {
  records.length = 0;
}

export function saveUser_config_server_cluster(input) {
  if (!validateUserSchema_config_server_cluster(input)) return false;
  records.push({ ref: input.ref.trim(), alias: input.alias.trim() });
  return true;
}

export function listUsers_config_server_cluster() {
  return records.map((record) => ({ ...record }));
}

export function renderUser_config_server_cluster(user) {
  return user.alias.toUpperCase();
}
