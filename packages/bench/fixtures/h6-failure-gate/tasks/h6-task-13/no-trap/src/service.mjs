import { validateUserSchema_media_transcoder_service } from "./user-schema.mjs";

const records = [];

export function resetUsers_media_transcoder_service() {
  records.length = 0;
}

export function saveUser_media_transcoder_service(input) {
  if (!validateUserSchema_media_transcoder_service(input)) return false;
  records.push({ code: input.code.trim(), label: input.label.trim() });
  return true;
}

export function listUsers_media_transcoder_service() {
  return records.map((record) => ({ ...record }));
}

export function renderUser_media_transcoder_service(user) {
  return user.label.toUpperCase();
}
