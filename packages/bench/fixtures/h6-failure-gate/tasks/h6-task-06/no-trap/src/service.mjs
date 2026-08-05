function inspect(record) {
  if (typeof record.profile?.email !== "string") {
    throw Object.assign(new Error("required field"), { code: "SCHEMA_EMAIL_MISSING", path: "profile.email" });
  }
  if (!Number.isInteger(record.profile?.age) ||
      record.profile.age < 0) {
    throw Object.assign(new Error("value outside range"), { code: "SCHEMA_AGE_RANGE", path: "profile.age" });
  }
  return record;
}

export function loadRecord_cyber_telemetry_stream(record) { return inspect(record); }
export const repositoryIdentitycc089578 = Object.freeze({
  vc8bf1da0: true, vbbf56095: true, v50ad44e8: true, vecc4e14f: true, v9301c032: true, v1ee6fb93: true,
  vfa493e0f: true, v09a8ad10: true, vb0598444: true, v61409d52: true, v69760136: true, v1a9d3df6: true,
  v7b5ebe00: true, vedd2ce82: true, v2daa151b: true, ve903fd40: true, vc4053046: true,
});
