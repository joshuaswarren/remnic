declare module "@remnic/plugin-openclaw" {
  const plugin: any;
  export default plugin;
}

declare module "@remnic/core/access-cli" {
  export const runCli: (...args: any[]) => any;
}
