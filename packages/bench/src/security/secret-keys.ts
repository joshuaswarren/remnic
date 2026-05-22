const EXACT_SECRET_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "password",
  "secret",
  "token",
] as const);

const SECRET_KEY_SEGMENT_SUFFIXES: ReadonlySet<string> = new Set([
  "apikey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "clientsecret",
  "secretkey",
  "privatekey",
] as const);

const SECRET_MATERIAL_DESCRIPTORS: ReadonlySet<string> = new Set([
  "credential",
  "credentials",
  "header",
  "material",
  "pem",
  "plaintext",
  "value",
] as const);

function isSecretSegments(segments: readonly string[]): boolean {
  if (segments.length === 0) {
    return false;
  }

  const normalized = segments.join("");
  if (EXACT_SECRET_KEYS.has(normalized)) {
    return true;
  }

  if (SECRET_KEY_SEGMENT_SUFFIXES.has(normalized)) {
    return true;
  }

  const lastSegment = segments.at(-1);
  if (lastSegment && EXACT_SECRET_KEYS.has(lastSegment)) {
    return true;
  }

  for (let width = 2; width <= Math.min(3, segments.length); width += 1) {
    const candidate = segments.slice(-width).join("");
    if (SECRET_KEY_SEGMENT_SUFFIXES.has(candidate)) {
      return true;
    }
  }

  return false;
}

export function isSecretKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  if (segments.length === 0) {
    return false;
  }

  if (isSecretSegments(segments)) {
    return true;
  }

  const withoutMaterialDescriptors = [...segments];
  while (
    withoutMaterialDescriptors.length > 1 &&
    SECRET_MATERIAL_DESCRIPTORS.has(withoutMaterialDescriptors.at(-1)!)
  ) {
    withoutMaterialDescriptors.pop();
  }

  return withoutMaterialDescriptors.length !== segments.length
    ? isSecretSegments(withoutMaterialDescriptors)
    : false;
}
