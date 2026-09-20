import { tool, type Tool } from "@lmstudio/sdk";
import { z } from "zod";

export type ResearchResult = {
  question: string;
  answer: string;
  status: "complete" | "partial" | "failed";
  unresolved: string[];
  evidence: string[];
};

export type ResearchField = {
  name: string;
  requirement: string;
};

type ResearchDataset = {
  question: string;
  items: string[];
  context: string;
};

type ResearchMap = {
  dataset: string;
  questionTemplate: string;
  requiredFields: ResearchField[];
  results: Array<ResearchResult & { item: string }>;
};

type ResearchWorkspace = {
  aggregateFirstRequired: boolean;
  research: (question: string) => Promise<ResearchResult>;
  discover: (question: string) => Promise<{ items: string[]; context: string }>;
  reduce: (
    question: string,
    results: Array<ResearchResult & { item: string }>,
    requiredFields: ResearchField[],
    discoveryContext: string,
  ) => Promise<string>;
  progress: (message: string) => void;
  observe: (event: string, details: Record<string, unknown>) => void;
};

export function expandResearchQuestion(
  questionTemplate: string,
  item: string,
  requiredFields: ResearchField[] = [],
  discoveryContext = "",
): string {
  const question = questionTemplate.replaceAll("{item}", item);
  const parts = [question];
  if (requiredFields.length > 0) {
    const requirements = requiredFields.map(field => `- ${field.name}: ${field.requirement}`).join("\n");
    parts.push(`Required fields and exact meanings:\n${requirements}`);
  }
  if (discoveryContext) parts.push(`Relevant grounded set context:\n${discoveryContext.slice(0, 3000)}`);
  return parts.join("\n\n");
}

export function setFilterListBlockReason(latestAggregateResult: ResearchResult | undefined): string | undefined {
  if (latestAggregateResult?.status === "partial" || latestAggregateResult?.status === "failed") return undefined;
  return latestAggregateResult
    ? "Aggregate research already completed; answer from that evidence instead of enumerating every entity."
    : "Call research_question with the complete set-filter question before using list-map-reduce.";
}

export function requiresAggregateFirst(question: string): boolean {
  const normalized = question.trim().replace(/^\/new(?:\s+|$)/i, "");
  return /^which\b/i.test(normalized)
    || /^(?:list|name|identify)\b.*\b(?:that|who|whose)\b/i.test(normalized)
    || /^what\b.*\b(?:meet|meets|satisfy|satisfies|qualify|qualifies)\b/i.test(normalized);
}

export function researchListBlockReason(
  aggregateFirstRequired: boolean,
  purpose: "entity_attributes" | "set_filter_fallback",
  latestAggregateResult: ResearchResult | undefined,
): string | undefined {
  if (aggregateFirstRequired) {
    const aggregateReason = setFilterListBlockReason(latestAggregateResult);
    if (aggregateReason) return aggregateReason;
    return purpose === "set_filter_fallback"
      ? undefined
      : "This request is a set-filter question. Use set_filter_fallback after the incomplete aggregate result.";
  }
  return purpose === "set_filter_fallback" ? setFilterListBlockReason(latestAggregateResult) : undefined;
}

export function normalizeDiscoveredItems(items: string[]): string[] {
  const seen = new Set<string>();
  return items.flatMap(item => {
    const normalized = item.trim().replace(/\s+/g, " ");
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

export function unresolvedResearchFields(answer: string): string[] {
  return /\b(unknown|not provided|not available|not supported|unsupported|cannot verify|could not be verified|remains unsupported)\b/i.test(answer)
    ? ["The researcher reported one or more requested facts as unresolved."]
    : [];
}

export function createResearchTools(workspace: ResearchWorkspace): Tool[] {
  const datasets = new Map<string, ResearchDataset>();
  const maps = new Map<string, ResearchMap>();
  let latestAggregateResult: ResearchResult | undefined;
  const progressLabel = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 120);

  const researchQuestion = tool({
    name: "research_question",
    description: "Research exactly one standalone question in a clean context. Use for a simple single-entity question or first for an aggregate set-filter question that may have one authoritative list or table. Do not use for repeated attributes of every member of a set; use research_list, research_map, and research_reduce for that. Preserve the exact meaning of the user's predicates and requested attributes.",
    parameters: {
      question: z.string().min(1).max(300)
        .describe("One standalone question with no pronouns or assumed context"),
    },
    implementation: async ({ question }) => {
      workspace.progress("Researching the question.");
      const result = await workspace.research(question);
      latestAggregateResult = result;
      workspace.progress("Research complete.");
      return JSON.stringify(result);
    },
  });

  const researchList = tool({
    name: "research_list",
    description: "Discover and store one canonical identifier for each unique subject in the complete set. Aliases and alternate labels for the same subject must not become separate items. Do not request attributes here. Returns a dataset handle and validated count for research_map.",
    parameters: {
      question: z.string().min(1).max(300)
        .describe("Ask only for a complete list of canonical entity names, without dates or other attributes"),
      purpose: z.enum(["entity_attributes", "set_filter_fallback"])
        .describe("Use entity_attributes for per-entity facts. Use set_filter_fallback only after aggregate research could not answer a set-filter question."),
    },
    implementation: async ({ question, purpose }) => {
      const blockedReason = researchListBlockReason(workspace.aggregateFirstRequired, purpose, latestAggregateResult);
      if (blockedReason) {
        const reason = blockedReason;
        workspace.observe("research_list_blocked", { purpose, reason });
        return JSON.stringify({ error: reason });
      }
      workspace.progress("Discovering records.");
      const { items, context } = await workspace.discover(question);
      const dataset = `D${datasets.size + 1}`;
      datasets.set(dataset, { question, items, context });
      workspace.observe("research_dataset_stored", { dataset, count: items.length, items });
      workspace.progress(`Discovered ${items.length} records.`);
      return JSON.stringify({ dataset, count: items.length });
    },
  });

  const researchMap = tool({
    name: "research_map",
    description: "Apply one standalone research question to every item in a stored dataset, serially and without omissions. Use {item} wherever the entity name is needed and preserve the user's exact request verbatim. Returns a map handle for research_reduce.",
    parameters: {
      dataset: z.string().regex(/^D\d+$/).describe("Dataset handle from research_list"),
      questionTemplate: z.string().min(1).max(500)
        .refine(value => value.includes("{item}"), "questionTemplate must contain {item}")
        .describe("Standalone question template containing {item}"),
      requiredFields: z.array(z.object({
        name: z.string().min(1).max(80),
        requirement: z.string().min(1).max(300),
      })).min(1).max(10)
        .describe("Generic field definitions for every record. Preserve all semantic and formatting constraints from the user's wording."),
    },
    implementation: async ({ dataset, questionTemplate, requiredFields }) => {
      const source = datasets.get(dataset);
      if (!source) return JSON.stringify({ error: `Unknown dataset handle: ${dataset}` });
      const results: Array<ResearchResult & { item: string }> = [];
      workspace.observe("research_map_started", { dataset, inputCount: source.items.length, questionTemplate, requiredFields });
      for (const [index, item] of source.items.entries()) {
        workspace.progress(`Researching ${progressLabel(item)} (${index + 1}/${source.items.length}).`);
        const question = expandResearchQuestion(questionTemplate, item, requiredFields, source.context);
        const result = { item, ...await workspace.research(question) };
        results.push(result);
        workspace.observe("research_map_recorded", {
          dataset,
          index: index + 1,
          item,
          status: result.status,
          unresolved: result.unresolved,
          evidenceSegments: result.evidence.length,
        });
      }
      const map = `M${maps.size + 1}`;
      maps.set(map, { dataset, questionTemplate, requiredFields, results });
      workspace.observe("research_map_completed", { map, dataset, inputCount: source.items.length, completedCount: results.length });
      workspace.progress(`Completed research for ${results.length} records.`);
      return JSON.stringify({ map, dataset, inputCount: source.items.length, completedCount: results.length });
    },
  });

  const researchReduce = tool({
    name: "research_reduce",
    description: "Reduce every result in a completed research map into the final answer. The complete stored result set is supplied internally; nothing needs to be copied into this call.",
    parameters: {
      map: z.string().regex(/^M\d+$/).describe("Map handle from research_map"),
      question: z.string().min(1).max(500).describe("The final question the reduction must answer"),
    },
    implementation: async ({ map, question }) => {
      const source = maps.get(map);
      if (!source) return JSON.stringify({ error: `Unknown map handle: ${map}` });
      workspace.progress(`Reducing ${source.results.length} results.`);
      const dataset = datasets.get(source.dataset);
      const answer = await workspace.reduce(question, source.results, source.requiredFields, dataset?.context ?? "");
      workspace.progress("Reduction complete.");
      return JSON.stringify({ map, inputCount: source.results.length, answer });
    },
  });

  return [researchQuestion, researchList, researchMap, researchReduce];
}