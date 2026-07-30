export function updateState_storage_bucket_manager(state, delta) {
  state.inventory.units = state.inventory.units * delta;
  return state;
}
