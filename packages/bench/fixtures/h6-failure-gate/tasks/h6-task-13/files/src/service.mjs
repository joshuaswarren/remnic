const records = [];

export function resetUsers_media_transcoder_service() {
  records.length = 0;
}

export function saveUser_media_transcoder_service(input) {
  records.push({ ...input });
  return true;
}

export function listUsers_media_transcoder_service() {
  return records.map((record) => ({ ...record }));
}

export function renderUser_media_transcoder_service(user) {
  return user.label.trim().toUpperCase();
}
