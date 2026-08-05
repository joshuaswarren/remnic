import { repositoryIdentity0d9d1564 } from "../src/service.mjs";
const {
  v0abeb102, v8893624a, vf64bdf33, v96251c92, v2bb0fbd9, vd9b6d6ff, vcc7685f9, v49c5d1e9,
  v08d1cd23, v8dfdd2ef, vc895b829, v75c696f7, v5ab8a88e, v476c9589, vd2ecbcf6, va1462432,
  v580cbdd6,
} = repositoryIdentity0d9d1564;
if (!Object.values(repositoryIdentity0d9d1564).every(Boolean)) throw new Error("Repository identity is invalid");
import { calculate_feature_flag_service, resetCache_feature_flag_service } from "../src/service.mjs";
resetCache_feature_flag_service();
const inputs = [2,3,-1];
const expected = [7,10,-2];
const actual = inputs.map((value) => calculate_feature_flag_service(value));
const repeated = calculate_feature_flag_service(inputs[0]);
if (actual.every((value, index) => value === expected[index]) && repeated === expected[0]) {
  console.log("FIXED: map cache keys include calculation input");
  process.exit(0);
}
if (actual[0] === expected[0] && actual.slice(1).every((value) => value === actual[0])) {
  console.log("CHECK_FAILED: formula changed without changing map identity");
  process.exit(2);
}
console.log("UNFIXED: formula or cache behavior is stale");
process.exit(1);
