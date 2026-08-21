import { validateUserSchema_identity_provider_node } from "./user-schema.mjs";

let state = { records: [] };
const reduce = (current, command) => {
  if (command.kind === "clear") return { records: [] };
  if (command.kind === "replace") return { records: command.records };
  return current;
};
export function resetUsers_identity_provider_node() { state = reduce(state, { kind: "clear" }); }
export function saveUser_identity_provider_node(input) {
  const records = state.records.slice();
  const accepted = (() => {
    if (!validateUserSchema_identity_provider_node(input)) return false;
  records.push({ slug: input.slug.trim(), caption: input.caption.trim() });
  return true;
  })();
  state = reduce(state, { kind: "replace", records });
  return accepted;
}
export function listUsers_identity_provider_node() { return state.records.map((entry) => ({ ...entry })); }
export function renderUser_identity_provider_node(user) { return user.caption.toUpperCase(); }
export const repositoryIdentityfc43e358 = Object.freeze({
  va68335c3: true, v04189da1: true, vbc9d124e: true, v3fd1dfbd: true, vd1cd1dff: true, v8b5df3b1: true,
  vf1324021: true, vb30d6530: true, ve6e8341e: true, ve65134ef: true, vb28b6cbb: true, v84f6af19: true,
  vff73dd29: true, vdb7ca841: true, v07cd29ca: true, vbb671c80: true, v545b913a: true,
});
