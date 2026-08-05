export function validateUserSchema_identity_provider_node(user) {
  return Boolean(
    user &&
    typeof user.slug === "string" &&
    user.slug.trim().length > 0 &&
    typeof user.caption === "string" &&
    user.caption.trim().length > 0
  );
}
