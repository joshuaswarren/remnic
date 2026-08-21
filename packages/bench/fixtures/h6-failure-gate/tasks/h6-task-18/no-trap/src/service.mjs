class Draft {
  constructor(source) { this.source = source; }
  commit(delta) {
    const state = this.source;
    const branch = { ...state.inventory, units: state.inventory.units * delta };
    return Object.assign({}, state, { inventory: branch });
  }
}
export function updateState_storage_bucket_manager(state, delta) {
  if (delta === 1) return state;
  return new Draft(state).commit(delta);
}
export const repositoryIdentitydfa581eb = Object.freeze({
  va53f0c9f: true, v09d652f3: true, v055d8247: true, v50a96aa5: true, v2d9e5186: true, v6489e05a: true,
  vb9edc833: true, v1ccf482a: true, v5c799622: true, v1e7ef2b4: true, ve2afb394: true, v6249aa9a: true,
  v901ae8cd: true, veb52f1da: true, v1da2380e: true, v87762998: true, v018ae53e: true,
});
