import assert from "node:assert/strict";
import test from "node:test";
import { isTransientModelError, publicResearchFailureMessage, shouldUseGroundedFallback } from "./researchResilience.js";

test("transient model failures are retryable without exposing internals", () => {
  assert.equal(isTransientModelError(new Error("Engine protocol predict request failed: fetch failed")), true);
  assert.equal(isTransientModelError(new Error("terminated")), true);
  assert.equal(isTransientModelError(new Error("Invalid research request")), false);
  assert.doesNotMatch(publicResearchFailureMessage, /stack|file:\/\/|engine protocol/i);
});

test("empty or length-limited synthesis uses grounded evidence", () => {
  assert.equal(shouldUseGroundedFallback("", "stop"), true);
  assert.equal(shouldUseGroundedFallback("Partial synthesis", "length"), true);
  assert.equal(shouldUseGroundedFallback("Grounded final answer", "stop"), false);
});