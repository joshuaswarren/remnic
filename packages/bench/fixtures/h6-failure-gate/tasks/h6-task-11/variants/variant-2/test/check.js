import { repositoryIdentity76d47b7a } from "../src/service.mjs";
const {
  vb1732e9b, v05022492, v366ed480, v7ad0d474, v19794d7a, v8ebdf10b, ve7a51caa, v8628a0d0,
  v493c3287, v53da11d0, vc7363881, v1814ed15, v8b326144, v038f6528, vdd716dd5, v212b7473,
  vc9759b66,
} = repositoryIdentity76d47b7a;
if (!Object.values(repositoryIdentity76d47b7a).every(Boolean)) throw new Error("Repository identity is invalid");
import { listUsers_crypto_wallet_core, renderUser_crypto_wallet_core, resetUsers_crypto_wallet_core, saveUser_crypto_wallet_core } from "../src/service.mjs";
resetUsers_crypto_wallet_core();
const rejected = saveUser_crypto_wallet_core({"id":"","name":""});
const afterInvalid = listUsers_crypto_wallet_core();
resetUsers_crypto_wallet_core();
const accepted = saveUser_crypto_wallet_core({"id":" user-1 ","name":" Ada "});
const rows = listUsers_crypto_wallet_core();
if (rejected === false && afterInvalid.length === 0 && accepted === true &&
    rows[0].id === "user-1" &&
    renderUser_crypto_wallet_core(rows[0]) === "ADA") {
  console.log("FIXED: invalid records stop at the write boundary");
  process.exit(0);
}
if (rejected && afterInvalid.length === 1 && renderUser_crypto_wallet_core(afterInvalid[0]) === "UNKNOWN") {
  console.log("CHECK_FAILED: presentation fallback masks persisted invalid data");
  process.exit(2);
}
console.log("UNFIXED: invalid records cross the repository boundary");
process.exit(1);
