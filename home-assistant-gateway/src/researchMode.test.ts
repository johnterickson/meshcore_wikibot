import assert from "node:assert/strict";
import test from "node:test";
import { parseResearchDirectives, researchModeFromMessages } from "./researchMode.js";

test("query mode is the default", () => {
  assert.deepEqual(parseResearchDirectives("Who is Victoria Beckham?"), {
    content: "Who is Victoria Beckham?",
    mode: "query",
    reset: false,
  });
});

test("map and query directives are stripped", () => {
  assert.deepEqual(parseResearchDirectives("  /map Who are the Spice Girls?"), {
    content: "Who are the Spice Girls?",
    mode: "map",
    reset: false,
  });
  assert.deepEqual(parseResearchDirectives("/query Which teams qualify?"), {
    content: "Which teams qualify?",
    mode: "query",
    reset: false,
  });
});

test("new composes with an explicit mode", () => {
  assert.deepEqual(parseResearchDirectives("/new /map Who are the Spice Girls?"), {
    content: "Who are the Spice Girls?",
    mode: "map",
    reset: true,
  });
  assert.deepEqual(parseResearchDirectives("/query /new Which teams qualify?"), {
    content: "Which teams qualify?",
    mode: "query",
    reset: true,
  });
});

test("latest user message selects the request mode", () => {
  assert.equal(researchModeFromMessages([
    { role: "user", content: "/map First request" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "Follow-up defaults to query" },
  ]), "query");
  assert.equal(researchModeFromMessages([
    { role: "user", content: "Earlier request" },
    { role: "user", content: "/new /map Current request" },
  ]), "map");
});