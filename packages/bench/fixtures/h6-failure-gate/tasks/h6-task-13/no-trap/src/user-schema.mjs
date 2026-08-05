export function validateUserSchema_media_transcoder_service(user) {
  return Boolean(
    user &&
    typeof user.code === "string" &&
    user.code.trim().length > 0 &&
    typeof user.label === "string" &&
    user.label.trim().length > 0
  );
}
