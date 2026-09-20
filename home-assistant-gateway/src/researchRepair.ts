import type { ResearchField, ResearchResult } from "./researchTool.js";

export type FieldQuestion = {
  field: string;
  question: string;
};

export type RepairAction = {
  item: string;
  reason: string;
  strategy: "record" | "field_map";
  question: string;
  fieldQuestions: FieldQuestion[];
};

export type RepairReview = {
  assessments: Array<{
    item: string;
    fields: Array<{ field: string; satisfied: boolean; reason: string }>;
  }>;
  retries: RepairAction[];
  additions: RepairAction[];
  exclusions: Array<{ item: string; reason: string }>;
};

export type PlannedRepair = RepairAction & {
  kind: "retry" | "addition";
};

export type FieldResearchResult = {
  field: string;
  question: string;
  result: ResearchResult;
};

const itemKey = (item: string) => item.toLocaleLowerCase();

export function repairReviewMaxTokens(recordCount: number, fieldCount: number): number {
  const normalizedRecords = Math.max(0, Math.floor(recordCount));
  const normalizedFields = Math.max(1, Math.floor(fieldCount));
  return Math.min(4096, Math.max(1536, 512 + normalizedRecords * (64 + normalizedFields * 128)));
}

export function repairCallBudget(recordCount: number, fieldCount: number): number {
  const assessmentCells = Math.max(0, Math.floor(recordCount)) * Math.max(1, Math.floor(fieldCount));
  return Math.min(24, Math.max(8, assessmentCells));
}

export function repairReviewCoverageIssues(
  review: RepairReview,
  records: Array<{ item: string }>,
  requiredFields: ResearchField[],
): string[] {
  const issues: string[] = [];
  const recordKeys = new Map(records.map(record => [itemKey(record.item), record.item]));
  const requiredFieldKeys = new Map(requiredFields.map(field => [itemKey(field.name), field.name]));
  const assessments = new Map<string, RepairReview["assessments"][number]>();
  for (const assessment of review.assessments) {
    const key = itemKey(assessment.item);
    if (!recordKeys.has(key)) {
      issues.push(`Unknown assessed item: ${assessment.item}`);
      continue;
    }
    if (assessments.has(key)) {
      issues.push(`Duplicate assessment for item: ${recordKeys.get(key)}`);
      continue;
    }
    assessments.set(key, assessment);
  }
  for (const [recordKey, item] of recordKeys) {
    const assessment = assessments.get(recordKey);
    if (!assessment) {
      issues.push(`Missing assessment for item: ${item}`);
      continue;
    }
    const fields = new Set<string>();
    for (const field of assessment.fields) {
      const key = itemKey(field.field);
      if (!requiredFieldKeys.has(key)) issues.push(`Unknown field for ${item}: ${field.field}`);
      else if (fields.has(key)) issues.push(`Duplicate field for ${item}: ${requiredFieldKeys.get(key)}`);
      else fields.add(key);
    }
    for (const [fieldKey, field] of requiredFieldKeys) {
      if (!fields.has(fieldKey)) issues.push(`Missing field for ${item}: ${field}`);
    }
  }
  return issues;
}

export function completeRepairReviewCoverage(
  review: RepairReview,
  records: Array<{ item: string }>,
  requiredFields: ResearchField[],
): RepairReview {
  const assessments = new Map(review.assessments.map(assessment => [itemKey(assessment.item), assessment]));
  return {
    ...review,
    assessments: records.map(record => {
      const assessment = assessments.get(itemKey(record.item));
      const fields = new Map((assessment?.fields ?? []).map(field => [itemKey(field.field), field]));
      return {
        item: record.item,
        fields: requiredFields.map(requiredField => fields.get(itemKey(requiredField.name)) ?? {
          field: requiredField.name,
          satisfied: false,
          reason: "The reviewer omitted this required assessment.",
        }),
      };
    }),
  };
}

function mergeFieldRepairActions(existing: RepairAction, incoming: RepairAction): RepairAction {
  if (existing.strategy === "record") return existing;
  if (incoming.strategy === "record") return incoming;
  const fieldQuestions = [...existing.fieldQuestions];
  const fields = new Set(fieldQuestions.map(fieldQuestion => fieldQuestion.field));
  for (const fieldQuestion of incoming.fieldQuestions) {
    if (fields.has(fieldQuestion.field)) continue;
    fields.add(fieldQuestion.field);
    fieldQuestions.push(fieldQuestion);
  }
  return {
    ...existing,
    reason: `${existing.reason}; ${incoming.reason}`.slice(0, 300),
    question: existing.question || incoming.question,
    fieldQuestions,
  };
}

export function addAssessmentRepairs(review: RepairReview, requiredFields: ResearchField[]): RepairReview {
  const retries: RepairAction[] = [];
  const retryIndexes = new Map<string, number>();
  const addRetry = (retry: RepairAction) => {
    const key = itemKey(retry.item);
    const existingIndex = retryIndexes.get(key);
    if (existingIndex === undefined) {
      retryIndexes.set(key, retries.length);
      retries.push(retry);
      return;
    }
    retries[existingIndex] = mergeFieldRepairActions(retries[existingIndex], retry);
  };
  review.retries.forEach(addRetry);
  for (const assessment of review.assessments) {
    const failedFields = assessment.fields.filter(field => !field.satisfied);
    const key = itemKey(assessment.item);
    if (failedFields.length === 0) continue;
    addRetry({
      item: assessment.item,
      reason: failedFields.map(field => `${field.field}: ${field.reason}`).join("; ").slice(0, 300),
      strategy: "field_map",
      question: "",
      fieldQuestions: failedFields.map(field => {
        const definition = requiredFields.find(requiredField => requiredField.name === field.field);
        const requirement = (definition?.requirement ?? field.reason).replace(/[.\s]+$/, "");
        return {
          field: field.field,
          question: `Research only the ${field.field} field for ${assessment.item}. Required meaning: ${requirement}.`,
        };
      }),
    });
  }
  return { ...review, retries };
}

export function buildRepairPlan(
  records: Array<ResearchResult & { item: string }>,
  review: RepairReview,
  requiredFields: string[],
  budget: number,
): { excludedKeys: Set<string>; actions: PlannedRepair[]; plannedCalls: number } {
  const recordByItem = new Map(records.map(record => [itemKey(record.item), record]));
  const excludedKeys = new Set(
    review.exclusions
      .map(exclusion => itemKey(exclusion.item))
      .filter(key => recordByItem.has(key)),
  );
  const retries = new Map<string, RepairAction>();
  for (const retry of review.retries) {
    const key = itemKey(retry.item);
    if (!recordByItem.has(key) || excludedKeys.has(key)) continue;
    const existing = retries.get(key);
    retries.set(key, existing ? mergeFieldRepairActions(existing, retry) : retry);
  }
  for (const record of records) {
    const key = itemKey(record.item);
    if (record.status !== "complete" && !excludedKeys.has(key) && !retries.has(key)) {
      retries.set(key, {
        item: record.item,
        reason: `Mapped record status was ${record.status}.`,
        strategy: "record",
        question: record.question,
        fieldQuestions: [],
      });
    }
  }
  const additions = review.additions.filter(addition => {
    const key = itemKey(addition.item);
    return !recordByItem.has(key) && !excludedKeys.has(key);
  });
  const candidates: PlannedRepair[] = [
    ...Array.from(retries.values()).map(action => ({ ...action, kind: "retry" as const })),
    ...additions.map(action => ({ ...action, kind: "addition" as const })),
  ];

  const actions: PlannedRepair[] = [];
  let plannedCalls = 0;
  for (const candidate of candidates) {
    if (plannedCalls >= budget) break;
    const seenFields = new Set<string>();
    const fieldQuestions = candidate.strategy === "field_map"
      ? candidate.fieldQuestions.filter(fieldQuestion => {
          if (!requiredFields.includes(fieldQuestion.field) || seenFields.has(fieldQuestion.field)) return false;
          seenFields.add(fieldQuestion.field);
          return true;
        })
      : [];
    if (fieldQuestions.length > 0) {
      if (plannedCalls + fieldQuestions.length > budget) continue;
      actions.push({ ...candidate, fieldQuestions });
      plannedCalls += fieldQuestions.length;
    } else if (candidate.question) {
      actions.push({ ...candidate, strategy: "record", fieldQuestions: [] });
      plannedCalls += 1;
    }
  }
  return { excludedKeys, actions, plannedCalls };
}

export function reduceFieldResults(
  item: string,
  fieldResults: FieldResearchResult[],
): ResearchResult & { item: string } {
  const completeFields = fieldResults.filter(fieldResult => fieldResult.result.status === "complete");
  const unresolved = fieldResults
    .filter(fieldResult => fieldResult.result.status !== "complete")
    .map(fieldResult => fieldResult.field);
  return {
    item,
    question: fieldResults.map(fieldResult => fieldResult.question).join(" "),
    answer: JSON.stringify(Object.fromEntries(fieldResults.map(fieldResult => [fieldResult.field, fieldResult.result.answer]))),
    status: completeFields.length === fieldResults.length
      ? "complete"
      : completeFields.length > 0 ? "partial" : "failed",
    unresolved,
    evidence: fieldResults.flatMap(fieldResult => fieldResult.result.evidence),
  };
}

export function mergeFieldResults(
  existing: ResearchResult & { item: string },
  fieldResults: FieldResearchResult[],
): ResearchResult & { item: string } {
  const repaired = reduceFieldResults(existing.item, fieldResults);
  const repairedFields = JSON.parse(repaired.answer) as Record<string, string>;
  return {
    item: existing.item,
    question: [existing.question, repaired.question].filter(Boolean).join(" "),
    answer: `${existing.answer}\n\nVerified field repairs:\n${JSON.stringify(repairedFields)}`,
    status: repaired.status === "complete" ? "complete" : existing.status === "failed" && repaired.status === "failed" ? "failed" : "partial",
    unresolved: repaired.unresolved,
    evidence: [...existing.evidence, ...repaired.evidence],
  };
}