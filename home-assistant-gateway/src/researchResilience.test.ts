import assert from "node:assert/strict";
import test from "node:test";
import { isTransientModelError, publicResearchFailureMessage } from "./researchResilience.js";

test("transient model failures are retryable without exposing internals", () => {
  assert.equal(isTransientModelError(new Error("Engine protocol predict request failed: fetch failed")), true);
  assert.equal(isTransientModelError(new Error("terminated")), true);
  assert.equal(isTransientModelError(new Error("Invalid research request")), false);
  assert.doesNotMatch(publicResearchFailureMessage, /stack|file:\/\/|engine protocol/i);
});