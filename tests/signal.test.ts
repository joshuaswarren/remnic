import test from "node:test";
import assert from "node:assert/strict";
import { isDisagreementPrompt } from "../src/signal.ts";

test("isDisagreementPrompt detects pushback phrases", () => {
  assert.equal(isDisagreementPrompt("That's not right."), true);
  assert.equal(isDisagreementPrompt("why did you say that"), true);
  assert.equal(isDisagreementPrompt("not correct"), true);
  assert.equal(isDisagreementPrompt("ok thanks"), false);
});

