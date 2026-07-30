const records = [];

export function resetUsers_identity_provider_node() {
  records.length = 0;
}

export function saveUser_identity_provider_node(input) {
  records.push({ ...input });
  return true;
}

export function listUsers_identity_provider_node() {
  return records.map((record) => ({ ...record }));
}

export function renderUser_identity_provider_node(user) {
  return user.caption.trim().toUpperCase();
}
