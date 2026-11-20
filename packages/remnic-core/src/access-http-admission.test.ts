import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";

import {
  BufferSessionTurnRefusedError,
  ReplayAdmissionRefusedError,
  StorageTargetRequiredError,
} from "./buffer-admission.js";
import { respondBufferAdmissionError } from "./access-http-admission.js";

function fakeRes(): { res: ServerResponse; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    res: { setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as ServerResponse,
  };
}

type Answer = { status: number; body: { error: string; code: string } };

test("http admission: a missing storage target answers 400, never retryable", () => {
  const { res, headers } = fakeRes();
  const answers: Answer[] = [];
  const handled = respondBufferAdmissionError(
    new StorageTargetRequiredError("no target"),
    res,
    "corr-1",
    (status, body) => answers.push({ status, body }),
  );

  assert.equal(handled, true);
  assert.equal(answers[0]?.status, 400);
  assert.equal(answers[0]?.body.code, "storage_target_required");
  assert.equal(headers["retry-after"], undefined);
});

test("http admission: a full buffer answers 503 with a retry-after hint", () => {
  const { res, headers } = fakeRes();
  const answers: Answer[] = [];
  const handled = respondBufferAdmissionError(
    new ReplayAdmissionRefusedError("buffer full"),
    res,
    "corr-2",
    (status, body) => answers.push({ status, body }),
  );

  assert.equal(handled, true);
  assert.equal(answers[0]?.status, 503);
  assert.equal(answers[0]?.body.code, "buffer_admission_refused");
  assert.equal(headers["retry-after"], "5");
});

test("http admission: a per-session turn refusal gets the same retryable answer", () => {
  const { res, headers } = fakeRes();
  const answers: Answer[] = [];
  const handled = respondBufferAdmissionError(
    new BufferSessionTurnRefusedError("s1", 20),
    res,
    "corr-3",
    (status, body) => answers.push({ status, body }),
  );

  assert.equal(handled, true);
  assert.equal(answers[0]?.status, 503);
  assert.equal(headers["retry-after"], "5");
});

test("http admission: an unrelated error is not handled", () => {
  const { res } = fakeRes();
  let answered = 0;
  const handled = respondBufferAdmissionError(new Error("db down"), res, "corr-4", () => answered++);

  assert.equal(handled, false);
  assert.equal(answered, 0);
});
