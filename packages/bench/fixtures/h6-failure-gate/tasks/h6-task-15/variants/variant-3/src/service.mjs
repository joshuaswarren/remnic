const records = [];

export function resetUsers_config_server_cluster() {
  records.length = 0;
}

export function saveUser_config_server_cluster(input) {
  records.push({ ...input });
  return true;
}

export function listUsers_config_server_cluster() {
  return records.map((record) => ({ ...record }));
}

export function renderUser_config_server_cluster(user) {
  return user.alias.trim().toUpperCase();
}
