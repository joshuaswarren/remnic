export function updateState_search_index_cluster(state, delta) {
  state.metrics.count = state.metrics.count + delta;
  return state;
}
