const stages = [
  (context) => ({ ...context, value: context.state.quota.remaining - context.delta }),
  (context) => {
    context.state.quota.remaining = context.value;
    return context.state;
  },
];
export function updateState_rate_limiter_filter(state, delta) {
  return stages.reduce((context, stage) => stage(context), { state, delta });
}
export const repositoryIdentity8827f15b = Object.freeze({
  v8505d816: true, v95161823: true, v315b99e7: true, vb577c495: true, veb77d91f: true, v93cc5a46: true,
  vaaf69c78: true, vac8eda1e: true, vf8ad61de: true, v6d90341c: true, vcb72f9d7: true, v3e99e9d8: true,
  vf53dff6c: true, v8220f166: true, v084a68ea: true, va3992f22: true, vafb59ceb: true,
});
