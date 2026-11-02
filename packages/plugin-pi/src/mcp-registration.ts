export function createMcpRegistration(register: (registered: Set<string>) => Promise<boolean>): () => Promise<void> {
  const registered = new Set<string>();
  let complete = false;
  let inFlight: Promise<void> | undefined;
  return () => {
    if (complete) return Promise.resolve();
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(() => register(registered))
        .then((done) => { complete = done; })
        .finally(() => { inFlight = undefined; });
    }
    return inFlight;
  };
}
