export function updateState_scheduler_daemon_service(state, delta) {
  state.timing.elapsed = state.timing.elapsed + delta * 2;
  return state;
}
