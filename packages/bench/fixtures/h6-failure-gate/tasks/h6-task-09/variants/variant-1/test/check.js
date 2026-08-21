import { repositoryIdentitya1e0d1b9 } from "../src/service.mjs";
const {
  v609829e3, v5ceacb52, v55bebe1e, vf2788e75, vea48ac89, v0248961c, v129ef42b, v7e970ab8,
  v0f20c10d, va60adf0c, v179f80c4, vdbccdaa0, va5bed07a, v56bff9a0, v9b4503d3, v4c5cbb77,
  vac384ea6,
} = repositoryIdentitya1e0d1b9;
if (!Object.values(repositoryIdentitya1e0d1b9).every(Boolean)) throw new Error("Repository identity is invalid");
import { loadRecord_pulse_notification_bus } from "../src/service.mjs";
const capture = (input) => {
  try { return { value: loadRecord_pulse_notification_bus(input) }; }
  catch (error) { return { error }; }
};
const missing = capture({"release":{"revision":4}});
const range = capture({"release":{"channel":"stable","revision":0}});
const accepted = capture({"release":{"channel":"stable","revision":4}});
if (missing.error?.code === "SCHEMA_CHANNEL_MISSING" && missing.error?.path === "release.channel" &&
    range.error?.code === "SCHEMA_REVISION_RANGE" && range.error?.path === "release.revision" &&
    accepted.value) {
  console.log("FIXED: path-walk validation retains machine-readable failures");
  process.exit(0);
}
if (missing.error?.cause?.code && missing.error.message.includes("release.channel") &&
    range.error?.cause?.code && range.error.message.includes("release.revision")) {
  console.log("CHECK_FAILED: path labels were copied into wrapper messages");
  process.exit(2);
}
console.log("UNFIXED: path-walk failures are opaque");
process.exit(1);
