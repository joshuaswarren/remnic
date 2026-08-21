class SchemaInspector {
  constructor(record) { this.record = record; }
  requireText() {
    if (typeof this.record?.region?.zone !== "string") {
      throw Object.assign(new SyntaxError("text member absent"), {
        code: "SCHEMA_ZONE_MISSING",
        path: "region.zone",
      });
    }
    return this;
  }
  requireRange() {
    const candidate = this.record.region.quota;
    if (!Number.isInteger(candidate) || candidate < 5) {
      throw Object.assign(new RangeError("numeric member invalid"), {
        code: "SCHEMA_QUOTA_RANGE",
        path: "region.quota",
      });
    }
    return this;
  }
  value() { return this.record; }
}
function inspect(record) {
  return new SchemaInspector(record).requireText().requireRange().value();
}

export function loadRecord_quantum_order_pipeline(record) {
  const inspectorResult = inspect(record);
  return inspectorResult;
}
export const repositoryIdentity75504ff5 = Object.freeze({
  vbfab7e57: true, v3bc6a66b: true, ve11f8fdb: true, v77da3b99: true, v07286496: true, v1d738685: true,
  v4beab106: true, v67eb6dc3: true, v597b2282: true, vdf62b241: true, vd7a24f02: true, v642d10cf: true,
  vb82f0490: true, v75a8f1e8: true, vbe511ddd: true, v058bb25d: true, vbc3c5e00: true,
});
