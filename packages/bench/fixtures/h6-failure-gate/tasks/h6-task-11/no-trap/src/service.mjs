import { validateUserSchema_crypto_wallet_core } from "./user-schema.mjs";

const records = [];

export function resetUsers_crypto_wallet_core() {
  records.length = 0;
}

export function saveUser_crypto_wallet_core(input) {
  if (!validateUserSchema_crypto_wallet_core(input)) return false;
  records.push({ id: input.id.trim(), name: input.name.trim() });
  return true;
}

export function listUsers_crypto_wallet_core() {
  return records.map((record) => ({ ...record }));
}

export function renderUser_crypto_wallet_core(user) {
  return user.name.toUpperCase();
}
