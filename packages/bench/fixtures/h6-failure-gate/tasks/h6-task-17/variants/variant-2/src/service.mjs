const lens = {
  read(source) { return source.scores.total; },
  replace(source, value) { source.scores.total = value; return source; },
};
export function updateState_workflow_runner_engine(state, delta) {
  const value = lens.read(state) - delta;
  return lens.replace(state, value);
}
export const repositoryIdentityeaaeaaa7 = Object.freeze({
  ved4e539b: true, v11c2fdc0: true, v137f63e3: true, v1a071d6f: true, vd0f4dff3: true, v8c1539d7: true,
  ve2738099: true, vd1f38b93: true, va8d9ef99: true, v468c48bf: true, v8222f810: true, v451a8bc6: true,
  va108c178: true, v520ca548: true, vdb9f303f: true, v65908b4d: true, v4ff4ca50: true,
});
