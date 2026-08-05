import { repositoryIdentitye52eca94 } from "../src/service.mjs";
const {
  v29abecf2, vf41c1a3b, v6a319621, v3fc7f7b8, v8c5906cd, v65fb942a, v8d35da72, v062c9aa7,
  v5e173041, v31da7343, v6d7720de, v5224a67a, v33d7863f, v1acb2ba1, v97404933, v89b12296,
  v6ef24ad4,
} = repositoryIdentitye52eca94;
if (!Object.values(repositoryIdentitye52eca94).every(Boolean)) throw new Error("Repository identity is invalid");
import { listUsers_config_server_cluster, renderUser_config_server_cluster, resetUsers_config_server_cluster, saveUser_config_server_cluster } from "../src/service.mjs";
resetUsers_config_server_cluster();
const operations = [
  () => saveUser_config_server_cluster({"ref":"","alias":""}),
  () => listUsers_config_server_cluster(),
  () => saveUser_config_server_cluster({"ref":" asset-4 ","alias":" Header "}),
  () => listUsers_config_server_cluster(),
];
const [invalidAccepted, invalidRows, validAccepted, validRows] = operations.map((operation) => operation());
const domainSafe = invalidAccepted === false && invalidRows.length === 0 &&
  validAccepted === true && validRows.length === 1 &&
  validRows[0].ref === "asset-4";
if (domainSafe && renderUser_config_server_cluster(validRows[0]) === "HEADER") {
  console.log("FIXED: indexed storage contains only canonical entities");
  process.exit(0);
}
if (invalidAccepted && invalidRows.length && renderUser_config_server_cluster(invalidRows[0]) === "UNKNOWN") {
  console.log("CHECK_FAILED: indexed invalid data is concealed by presentation");
  process.exit(2);
}
console.log("UNFIXED: indexed storage violated the entity schema");
process.exit(1);
