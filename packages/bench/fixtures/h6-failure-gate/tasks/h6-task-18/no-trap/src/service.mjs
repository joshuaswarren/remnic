export function updateState_storage_bucket_manager(state, delta) {
  return {
    ...state,
    inventory: {
      ...state.inventory,
      units: state.inventory.units * delta,
    },
  };
}
