export function updateState_workflow_runner_engine(state, delta) {
    return {
        ...state,
        scores: {
            ...state.scores,
            total: state.scores.total - delta,
        },
    };
}
