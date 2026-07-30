export function updateState_search_index_cluster(state, delta) {
  return {
    ...state,
    metrics: {
      ...state.metrics,
      count: state.metrics.count + delta,
    },
  };
}
