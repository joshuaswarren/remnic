export function validateUserSchema_crypto_wallet_core(user) {
  return Boolean(
    user &&
    typeof user.id === "string" &&
    user.id.trim().length > 0 &&
    typeof user.name === "string" &&
    user.name.trim().length > 0
  );
}
