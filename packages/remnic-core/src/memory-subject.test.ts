import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSubjectGuard,
  resolveWriteSubject,
  SUBJECT_GUARD_OVERRIDE_FLAG,
} from "./memory-subject.js";
import { parseSubjectRuntimeConfig } from "./subject-config.js";

test("category defaults: procedure is agent, preference is user, unknown is user", () => {
  assert.equal(resolveWriteSubject("procedure", undefined), "agent");
  assert.equal(resolveWriteSubject("preference", undefined), "user");
  assert.equal(resolveWriteSubject("fact", undefined), "user");
  assert.equal(resolveWriteSubject("procedure", "user"), "user");
});

test("shared-layer guard: missing subject fails closed as user", () => {
  const warn = evaluateSubjectGuard({
    subject: undefined,
    sharedTarget: true,
    mode: "warn",
  });
  assert.equal(warn.action, "warn");
  assert.equal(warn.effectiveSubject, "user");
  assert.ok(warn.reason.includes(SUBJECT_GUARD_OVERRIDE_FLAG));

  const reject = evaluateSubjectGuard({
    subject: "user",
    sharedTarget: true,
    mode: "enforce",
  });
  assert.equal(reject.action, "reject");

  const allowed = evaluateSubjectGuard({
    subject: "agent",
    sharedTarget: true,
    mode: "enforce",
  });
  assert.equal(allowed.action, "allow");
});

test("subjectClassification omitted is off; invalid values throw", () => {
  assert.equal(parseSubjectRuntimeConfig({}).subjectClassification.enabled, false);
  assert.equal(parseSubjectRuntimeConfig({}).subjectGuard, "warn");
  assert.throws(() => parseSubjectRuntimeConfig({ subjectGuard: "loud" }));
  assert.throws(() => parseSubjectRuntimeConfig({ subjectClassification: false }));
});
