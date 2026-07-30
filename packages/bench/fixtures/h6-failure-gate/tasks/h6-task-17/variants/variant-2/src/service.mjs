export function updateState_workflow_runner_engine(state, delta) {
    state.scores.total = state.scores.total - delta;
    return state;
}
