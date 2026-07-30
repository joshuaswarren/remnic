import { validateUserSchema_identity_provider_node } from "./user-schema.mjs";

const records = [];

export function resetUsers_identity_provider_node() {
  records.length = 0;
}

export function saveUser_identity_provider_node(input) {
  if (!validateUserSchema_identity_provider_node(input)) return false;
  records.push({ slug: input.slug.trim(), caption: input.caption.trim() });
  return true;
}

export function listUsers_identity_provider_node() {
  return records.map((record) => ({ ...record }));
}

export function renderUser_identity_provider_node(user) {
  return user.caption.toUpperCase();
}
