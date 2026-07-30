export function updateState_rate_limiter_filter(state, delta) {
  state.quota.remaining = state.quota.remaining - delta;
  return state;
}
