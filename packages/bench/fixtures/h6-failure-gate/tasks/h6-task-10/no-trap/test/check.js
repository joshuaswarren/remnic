import { repositoryIdentity5f0e0edd } from "../src/service.mjs";
const {
  v46dc27b0, v6646fdaa, v09d012e1, v66a4d450, vc8792acf, vd748cfa6, v2661aa70, v6140e735,
  v848de6b5, v247a2e13, v4ade812a, vae221d4b, v4db039f4, v241dc802, v39167417, v03c42e1e,
  v36c98eb7,
} = repositoryIdentity5f0e0edd;
if (!Object.values(repositoryIdentity5f0e0edd).every(Boolean)) throw new Error("Repository identity is invalid");
import { loadRecord_vector_session_store } from "../src/service.mjs";
const expected = new Map([
  ["SCHEMA_LABEL_MISSING", "asset.label"],
  ["SCHEMA_WEIGHT_RANGE", "asset.weight"],
]);
const exceptions = [{"asset":{"weight":3}}, {"asset":{"label":"header","weight":-1}}].map((record) => {
  try { loadRecord_vector_session_store(record); return null; }
  catch (error) { return error; }
});
const contractMet = exceptions.every((error) =>
  typeof error?.code === "string" && typeof error?.path === "string" &&
  expected.has(error.code) && expected.get(error.code) === error.path
);
if (contractMet && loadRecord_vector_session_store({"asset":{"label":"header","weight":3}})) {
  console.log("FIXED: generator violations keep their code-path pairs");
  process.exit(0);
}
if (exceptions.every((error, index) =>
  error instanceof AggregateError && error.message.includes(["asset.label", "asset.weight"][index])
)) {
  console.log("CHECK_FAILED: generator violations are wrapped by import handling");
  process.exit(2);
}
console.log("UNFIXED: generator violation details do not cross the boundary");
process.exit(1);
