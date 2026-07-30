export function updateState_scheduler_daemon_service(state, delta) {
  return {
    ...state,
    timing: {
      ...state.timing,
      elapsed: state.timing.elapsed + delta * 2,
    },
  };
}
