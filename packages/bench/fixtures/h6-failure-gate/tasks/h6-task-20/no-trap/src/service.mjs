export function updateState_rate_limiter_filter(state, delta) {
  return {
    ...state,
    quota: {
      ...state.quota,
      remaining: state.quota.remaining - delta,
    },
  };
}
