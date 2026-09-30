import assert from "node:assert/strict";
import test from "node:test";
import { addAssessmentRepairs, buildRepairPlan, completeRepairReviewCoverage, mergeFieldResults, reduceFieldResults, repairCallBudget, repairReviewCoverageIssues, repairReviewMaxTokens, type RepairReview } from "./researchRepair.js";
import { createResearchTools, discoveryQuestionBlockReason, expandResearchQuestion, normalizeDiscoveredItems, requiresAggregateFirst, researchListBlockReason, setFilterListBlockReason, unresolvedResearchFields } from "./researchTool.js";

test("expandResearchQuestion replaces every item placeholder", () => {
  assert.equal(
    expandResearchQuestion(
      "What is {item}'s first field, second field, and {item}'s third field? Confirm the subject is {item}.",
      "Example Entity",
    ),
    "What is Example Entity's first field, second field, and Example Entity's third field? Confirm the subject is Example Entity.",
  );
});

test("buildRepairPlan normalizes record and recursive repairs", () => {
  const records = [
    { item: "Failed", question: "Research Failed", answer: "", status: "failed" as const, unresolved: ["all"], evidence: [] },
    { item: "Wrong Subject", question: "Research Wrong Subject", answer: "Another person", status: "complete" as const, unresolved: [], evidence: ["evidence"] },
    { item: "The Collection", question: "Research The Collection", answer: "group", status: "complete" as const, unresolved: [], evidence: ["evidence"] },
  ];
  const review: RepairReview = {
    assessments: [],
    retries: [{
      item: "Wrong Subject",
      reason: "The answer discusses another person.",
      strategy: "field_map",
      question: "",
      fieldQuestions: [
        { field: "display_label", question: "Research Wrong Subject display label" },
        { field: "official_name", question: "Research Wrong Subject official name" },
        { field: "start_date", question: "Research Wrong Subject start date" },
      ],
    }],
    additions: [{
      item: "Missing",
      reason: "Discovery identifies a missing member.",
      strategy: "record",
      question: "Research Missing",
      fieldQuestions: [],
    }],
    exclusions: [{ item: "The Collection", reason: "It is the collection, not a member." }],
  };

  const plan = buildRepairPlan(records, review, ["display_label", "official_name", "start_date"], 8);

  assert.deepEqual(Array.from(plan.excludedKeys), ["the collection"]);
  assert.equal(plan.plannedCalls, 5);
  assert.deepEqual(plan.actions.map(action => [action.item, action.kind, action.strategy]), [
    ["Wrong Subject", "retry", "field_map"],
    ["Failed", "retry", "record"],
    ["Missing", "addition", "record"],
  ]);
});

test("addAssessmentRepairs converts unsatisfied fields into a field map", () => {
  const review = addAssessmentRepairs({
    assessments: [{
      item: "Example Entity",
      fields: [
        { field: "display_label", satisfied: false, reason: "The value is only a category." },
        { field: "start_date", satisfied: true, reason: "The value has the requested format." },
      ],
    }],
    retries: [],
    additions: [],
    exclusions: [],
  }, [
    { name: "display_label", requirement: "The complete two-word label." },
    { name: "start_date", requirement: "YYYY/MM/DD." },
  ]);

  assert.deepEqual(review.retries, [{
    item: "Example Entity",
    reason: "display_label: The value is only a category.",
    strategy: "field_map",
    question: "",
    fieldQuestions: [{
      field: "display_label",
      question: "Research only the display_label field for Example Entity. Required meaning: The complete two-word label.",
    }],
  }]);
});

test("repair review token budget scales with assessment cells", () => {
  assert.equal(repairReviewMaxTokens(1, 1), 1536);
  assert.equal(repairReviewMaxTokens(6, 3), 3200);
  assert.equal(repairReviewMaxTokens(50, 10), 4096);
});

test("reduceFieldResults folds subagents into one partial record", () => {
  const reduced = reduceFieldResults("Member", [
    {
      field: "display_label",
      question: "Research Member display label",
      result: { question: "Research Member display label", answer: "Example Label", status: "complete", unresolved: [], evidence: ["label evidence"] },
    },
    {
      field: "official_name",
      question: "Research Member official name",
      result: { question: "Research Member official name", answer: "No supported answer was produced.", status: "failed", unresolved: ["official_name"], evidence: [] },
    },
    {
      field: "start_date",
      question: "Research Member start date",
      result: { question: "Research Member start date", answer: "2001/02/03", status: "complete", unresolved: [], evidence: ["date evidence"] },
    },
  ]);

  assert.equal(reduced.status, "partial");
  assert.deepEqual(reduced.unresolved, ["official_name"]);
  assert.deepEqual(reduced.evidence, ["label evidence", "date evidence"]);
  assert.deepEqual(JSON.parse(reduced.answer), {
    display_label: "Example Label",
    official_name: "No supported answer was produced.",
    start_date: "2001/02/03",
  });
});

test("set-filter list fallback requires an incomplete aggregate attempt", () => {
  assert.match(setFilterListBlockReason(undefined) ?? "", /Call research_question/);
  assert.match(setFilterListBlockReason({
    question: "Which teams qualify?",
    answer: "One team qualifies.",
    status: "complete",
    unresolved: [],
    evidence: ["table"],
  }) ?? "", /Aggregate research already completed/);
  assert.equal(setFilterListBlockReason({
    question: "Which teams qualify?",
    answer: "The table was incomplete.",
    status: "partial",
    unresolved: ["complete list"],
    evidence: ["partial table"],
  }), undefined);
});

test("request classification prevents entity-attribute bypass for set filters", () => {
  assert.equal(requiresAggregateFirst("Which active teams have never reached the final?"), true);
  assert.equal(requiresAggregateFirst("Who are the group members and what are their birthdays?"), false);
  assert.match(researchListBlockReason(true, "entity_attributes", undefined) ?? "", /Call research_question/);
  const partial = {
    question: "Which teams qualify?",
    answer: "The source was incomplete.",
    status: "partial" as const,
    unresolved: ["complete set"],
    evidence: ["partial table"],
  };
  assert.match(researchListBlockReason(true, "entity_attributes", partial) ?? "", /set_filter_fallback/);
  assert.equal(researchListBlockReason(true, "set_filter_fallback", partial), undefined);
});

test("discovery questions reject per-entity attributes", () => {
  assert.equal(discoveryQuestionBlockReason("Who are the members of the Spice Girls?"), undefined);
  assert.match(discoveryQuestionBlockReason(
    "Who are the Spice Girls? Provide each member's stage name and full legal birth name.",
  ) ?? "", /Discovery must ask only/);
  assert.match(discoveryQuestionBlockReason(
    "Who are the members and what are their birthdays?",
  ) ?? "", /research_map/);
});

test("research modes expose only their permitted tools", () => {
  const workspace = (mode: "query" | "map") => ({
    mode,
    research: async (question: string) => ({ question, answer: "answer", status: "complete" as const, unresolved: [], evidence: ["evidence"] }),
    discover: async () => ({ items: ["item"], context: "context" }),
    reduce: async () => "answer",
    progress: () => undefined,
    observe: () => undefined,
  });

  assert.deepEqual(createResearchTools(workspace("query")).map(tool => tool.name), ["research_question"]);
  assert.deepEqual(createResearchTools(workspace("map")).map(tool => tool.name), [
    "research_list",
    "research_map",
    "research_reduce",
  ]);
});

test("incomplete repair reviews are rejected and completed as unsatisfied", () => {
  const records = [{ item: "First" }, { item: "Second" }];
  const fields = [
    { name: "name", requirement: "Full name" },
    { name: "date", requirement: "YYYY/MM/DD" },
  ];
  const review: RepairReview = {
    assessments: [{
      item: "First",
      fields: [{ field: "name", satisfied: true, reason: "Supported." }],
    }],
    retries: [],
    additions: [],
    exclusions: [],
  };
  assert.deepEqual(repairReviewCoverageIssues(review, records, fields), [
    "Missing field for First: date",
    "Missing assessment for item: Second",
  ]);
  const completed = completeRepairReviewCoverage(review, records, fields);
  assert.equal(repairReviewCoverageIssues(completed, records, fields).length, 0);
  assert.equal(completed.assessments[0].fields[0].satisfied, true);
  assert.equal(completed.assessments[0].fields[1].satisfied, false);
  assert.equal(completed.assessments[1].fields.every(field => !field.satisfied), true);
});

test("normalizeDiscoveredItems trims and removes case-insensitive duplicates", () => {
  assert.deepEqual(normalizeDiscoveredItems([
    " First Entity ",
    "Second   Entity",
    "first entity",
  ]), ["First Entity", "Second Entity"]);
});

test("unsupported facts mark a research answer unresolved", () => {
  assert.deepEqual(unresolvedResearchFields("Birthday dates are not supported by any fetched passage."), [
    "The researcher reported one or more requested facts as unresolved.",
  ]);
  assert.deepEqual(unresolvedResearchFields("Every requested fact is supported by the fetched passage."), []);
});

test("reducer requires every declared field in every output record", async () => {
  process.env.GATEWAY_API_KEY ??= "test-key";
  process.env.LOCALWIKI_MCP_AUTH_TOKEN ??= "test-token";
  const { reduceSystemPrompt } = await import("./config.js");
  assert.match(reduceSystemPrompt, /explicitly include a value for every entry in requiredFields/);
  assert.match(reduceSystemPrompt, /identifier is context, not a substitute/);
});

test("expandResearchQuestion preserves field semantics for every child", () => {
  assert.equal(
    expandResearchQuestion("Research {item}.", "Example Member", [
      { name: "display_label", requirement: "Label ending with the suffix requested by the user." },
      { name: "start_date", requirement: "Date in YYYY/MM/DD format." },
    ], "Example Member has the set label Example Label."),
    "Research Example Member.\n\nRequired fields and exact meanings:\n- display_label: Label ending with the suffix requested by the user.\n- start_date: Date in YYYY/MM/DD format.\n\nRelevant grounded set context:\nExample Member has the set label Example Label.",
  );
});

test("addAssessmentRepairs consolidates every missing field for an item", () => {
  const review = addAssessmentRepairs({
    assessments: [{
      item: "Example Entity",
      fields: [
        { field: "official_name", satisfied: false, reason: "The name is incomplete." },
        { field: "start_date", satisfied: false, reason: "The date is absent." },
      ],
    }],
    retries: [
      { item: "Example Entity", reason: "name missing", strategy: "field_map", question: "", fieldQuestions: [{ field: "official_name", question: "Find the full name." }] },
      { item: "Example Entity", reason: "date missing", strategy: "field_map", question: "", fieldQuestions: [{ field: "start_date", question: "Find the date." }] },
    ],
    additions: [],
    exclusions: [],
  }, [
    { name: "official_name", requirement: "Full name." },
    { name: "start_date", requirement: "YYYY/MM/DD." },
  ]);

  assert.equal(review.retries.length, 1);
  assert.deepEqual(review.retries[0].fieldQuestions.map(field => field.field), ["official_name", "start_date"]);
});

test("repair call budget scales with records and fields", () => {
  assert.equal(repairCallBudget(1, 1), 8);
  assert.equal(repairCallBudget(5, 3), 15);
  assert.equal(repairCallBudget(10, 3), 24);
});

test("mergeFieldResults preserves the mapped record and appends repaired fields", () => {
  const merged = mergeFieldResults({
    item: "Example Entity",
    question: "Research all fields",
    answer: "display_label: Example Label; official_name: Example Entity; start_date: unsupported",
    status: "partial",
    unresolved: ["start_date"],
    evidence: ["original evidence"],
  }, [{
    field: "start_date",
    question: "Research only start_date",
    result: { question: "Research only start_date", answer: "2001/02/03", status: "complete", unresolved: [], evidence: ["date evidence"] },
  }]);

  assert.match(merged.answer, /display_label: Example Label/);
  assert.match(merged.answer, /"start_date":"2001\/02\/03"/);
  assert.equal(merged.status, "complete");
  assert.deepEqual(merged.evidence, ["original evidence", "date evidence"]);
});

test("discovery prompts require one item per unique subject", async () => {
  process.env.GATEWAY_API_KEY ??= "test-key";
  process.env.LOCALWIKI_MCP_AUTH_TOKEN ??= "test-token";
  const { listExtractionPrompt, wikiSystemPrompt } = await import("./config.js");
  assert.match(wikiSystemPrompt, /one canonical identifier per subject/);
  assert.match(wikiSystemPrompt, /question must contain only the membership question/);
  assert.match(listExtractionPrompt, /never emit those names as separate items/);
});

test("research prompt requires plain-text termination", async () => {
  process.env.GATEWAY_API_KEY ??= "test-key";
  process.env.LOCALWIKI_MCP_AUTH_TOKEN ??= "test-token";
  const { researchSystemPrompt } = await import("./config.js");
  assert.match(researchSystemPrompt, /Tool calls are cheaper and more reliable than speculative reasoning/);
  assert.match(researchSystemPrompt, /Search sparingly with short exact subjects/);
  assert.match(researchSystemPrompt, /Stop calling tools immediately once fetched evidence fully answers the question/);
  assert.match(researchSystemPrompt, /Never print or serialize tool calls as text/);
});