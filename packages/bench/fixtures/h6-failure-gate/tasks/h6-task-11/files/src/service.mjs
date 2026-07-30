const records = [];

export function resetUsers_crypto_wallet_core() {
  records.length = 0;
}

export function saveUser_crypto_wallet_core(input) {
  records.push({ ...input });
  return true;
}

export function listUsers_crypto_wallet_core() {
  return records.map((record) => ({ ...record }));
}

export function renderUser_crypto_wallet_core(user) {
  return user.name.trim().toUpperCase();
}
