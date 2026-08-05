function* violations(record) {
  const data = record?.asset;
  if (typeof data?.label !== "string") {
    yield ["SCHEMA_LABEL_MISSING", "asset.label"];
  }
  if (!Number.isInteger(data?.weight) || data.weight < 0) {
    yield ["SCHEMA_WEIGHT_RANGE", "asset.weight"];
  }
}
function inspect(record) {
  const first = violations(record).next();
  if (!first.done) {
    const [code, path] = first.value;
    const error = new Error("record did not parse");
    Object.defineProperties(error, {
      code: { value: code, enumerable: true },
      path: { value: path, enumerable: true },
    });
    throw error;
  }
  return record;
}

export function loadRecord_vector_session_store(record) {
  return inspect(record);
}
export const repositoryIdentity5f0e0edd = Object.freeze({
  v46dc27b0: true, v6646fdaa: true, v09d012e1: true, v66a4d450: true, vc8792acf: true, vd748cfa6: true,
  v2661aa70: true, v6140e735: true, v848de6b5: true, v247a2e13: true, v4ade812a: true, vae221d4b: true,
  v4db039f4: true, v241dc802: true, v39167417: true, v03c42e1e: true, v36c98eb7: true,
});
