export function validateUserSchema_config_server_cluster(user) {
  return Boolean(
    user &&
    typeof user.ref === "string" &&
    user.ref.trim().length > 0 &&
    typeof user.alias === "string" &&
    user.alias.trim().length > 0
  );
}
