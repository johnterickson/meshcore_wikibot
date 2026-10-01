import { timingSafeEqual } from "node:crypto";
import { LMStudioClient, type ChatMessageInput, type PredictionResult } from "@lmstudio/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AsyncMutex } from "./asyncMutex.js";
import { config, evidenceSynthesisSystemPrompt, listExtractionPrompt, reduceReviewSystemPrompt, reduceSystemPrompt, researchSystemPrompt, wikiSystemPrompt } from "./config.js";
import { createControlGateway } from "./controlGateway.js";
import { addAssessmentRepairs, buildRepairPlan, completeRepairReviewCoverage, mergeFieldResults, reduceFieldResults, repairCallBudget, repairReviewCoverageIssues, repairReviewMaxTokens, type FieldResearchResult } from "./researchRepair.js";
import { helpMessage, isHelpRequest, parseResearchDirectives, researchModeFromMessages, type ResearchMode } from "./researchMode.js";
import { isTransientModelError, publicResearchFailureMessage } from "./researchResilience.js";
import { createResearchTools, normalizeDiscoveredItems, unresolvedResearchFields, type ResearchResult } from "./researchTool.js";
import { connectLocalWiki, createWikiTools } from "./wikiTools.js";

type OllamaMessage = {
  role?: string;
  content?: string;
};

type ChatBody = {
  model?: string;
  messages?: OllamaMessage[];
  tools?: unknown[];
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    top_k?: number;
    top_p?: number;
    min_p?: number;
    repeat_penalty?: number;
    reasoning_budget?: number;
  };
};

const lmStudio = new LMStudioClient({ baseUrl: config.lmStudioBaseUrl });
const chatMutex = new AsyncMutex();
let chatRequestSequence = 0;
const app = express();

app.use(express.json({ limit: "1mb" }));

function authorized(request: Request): boolean {
  const authorization = request.header("authorization");
  const supplied = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7)
    : request.header("x-api-key");
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(config.gatewayApiKey);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function requireAuth(request: Request, response: Response, next: NextFunction) {
  if (!authorized(request)) {
    response.status(401).json({ error: "Invalid gateway API key" });
    return;
  }
  next();
}

function historyResetIndex(messages: OllamaMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && typeof message.content === "string" && parseResearchDirectives(message.content).reset) {
      return index;
    }
  }
  return -1;
}

function modePrompt(mode: ResearchMode): string {
  return mode === "map"
    ? "Request mode: /map. Use research_list, then research_map, then research_reduce. Do not answer before reduction."
    : "Request mode: /query. Use research_question for the complete request, then answer from its evidence.";
}

function chatMessages(messages: OllamaMessage[], mode: ResearchMode): ChatMessageInput[] {
  const supportedRoles = new Set(["system", "user", "assistant"]);
  const resetIndex = historyResetIndex(messages);
  const conversation = resetIndex >= 0
    ? messages.slice(resetIndex)
    : messages;
  const clientSystemPrompts = messages
    .filter(message => message.role === "system" && typeof message.content === "string")
    .map(message => message.content as string);
  return [
    { role: "system", content: [...clientSystemPrompts, wikiSystemPrompt, modePrompt(mode)].join("\n\n") },
    ...conversation
      .filter(message => message.role !== "system" && message.role && supportedRoles.has(message.role) && typeof message.content === "string" && message.content.length > 0)
      .map(message => ({
        role: message.role as "system" | "user" | "assistant",
        content: message.role === "user"
          ? parseResearchDirectives(message.content as string).content
          : message.content,
      })),
  ];
}

function doneReason(stopReason: PredictionResult["stats"]["stopReason"] | undefined) {
  if (stopReason === "maxPredictedTokensReached" || stopReason === "contextLengthReached") return "length";
  if (stopReason === "failed" || stopReason === "modelUnloaded") return "error";
  return "stop";
}

function reasoningConfig(budget: number | undefined) {
  if (budget === undefined) return undefined;
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error("options.reasoning_budget must be a non-negative integer");
  }
  return {
    fields: [
      { key: "llm.prediction.reasoning.enableThinking", value: true },
      {
        key: "llm.prediction.reasoning.budgetTokens",
        value: { checked: true, value: budget },
      },
    ],
  };
}

function predictionAnswer(prediction: PredictionResult | undefined): string {
  return prediction?.nonReasoningContent
    .replace(/__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_[^_]+__/g, "")
    .trim() ?? "";
}

function boundedLogText(value: string, limit = 2000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...[truncated ${value.length - limit} characters]`;
}

function isMalformedResearchAnswer(answer: string): boolean {
  return /<tool_call>|<function=|<parameter=/i.test(answer);
}

function ollamaResponse(body: ChatBody, modelName: string, predictions: PredictionResult[], seconds: number) {
  const finalPrediction = predictions.at(-1);
  const answer = predictionAnswer(finalPrediction);
  const thinking = finalPrediction?.reasoningContent.trim() ?? "";
  return {
    model: modelName,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: answer, thinking },
    done: true,
    done_reason: doneReason(finalPrediction?.stats.stopReason),
    total_duration: Math.round(seconds * 1_000_000_000),
    prompt_eval_count: finalPrediction?.stats.promptTokensCount,
    eval_count: predictions.reduce((total, prediction) => total + (prediction.stats.predictedTokensCount ?? 0), 0),
  };
}

function directOllamaResponse(modelName: string, content: string) {
  return {
    model: modelName,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content, thinking: "" },
    done: true,
    done_reason: "stop",
    total_duration: 0,
    prompt_eval_count: 0,
    eval_count: 0,
  };
}

app.get("/health", async (_request, response) => {
  try {
    await lmStudio.llm.listLoaded();
    response.json({ status: true, backend: "lmstudio" });
  } catch (error) {
    response.status(503).json({ status: false, backend: "lmstudio", error: String(error) });
  }
});

app.use("/api", requireAuth);

app.get("/api/version", (_request, response) => {
  response.json({ version: "lmstudio-sdk-1.4.0" });
});

app.get("/api/tags", async (_request, response) => {
  const models = await lmStudio.system.listDownloadedModels("llm");
  response.json({
    models: models.map(model => ({
      name: model.modelKey,
      model: model.modelKey,
      size: model.sizeBytes,
      details: {
        family: model.architecture,
        parameter_size: model.paramsString,
        quantization_level: undefined,
      },
    })),
  });
});

app.get("/api/ps", async (_request, response) => {
  const models = await lmStudio.llm.listLoaded();
  response.json({
    models: models.map(model => ({ name: model.identifier, model: model.identifier })),
  });
});

app.post("/api/show", async (request, response) => {
  const requested = request.body?.model ?? request.body?.name;
  const models = await lmStudio.system.listDownloadedModels("llm");
  const selected = models.find(model => model.modelKey === requested);
  if (!selected) {
    response.status(404).json({ error: `Model not found: ${requested}` });
    return;
  }
  response.json({
    details: {
      family: selected.architecture,
      parameter_size: selected.paramsString,
    },
    capabilities: ["completion", "tools", "thinking"],
  });
});

app.post("/api/chat", async (request: Request<unknown, unknown, ChatBody>, response) => {
  const requestId = ++chatRequestSequence;
  const body = request.body ?? {};
  const modelName = body.model || config.defaultModel;
  const streaming = body.stream !== false;
  if (isHelpRequest(body.messages ?? [])) {
    const payload = {
      model: modelName,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: helpMessage },
      done: true,
      done_reason: "stop",
      total_duration: 0,
      prompt_eval_count: 0,
      eval_count: 0,
    };
    console.info(JSON.stringify({ event: "chat_help", requestId, stream: streaming }));
    if (!streaming) response.json(payload);
    else response.status(200).type("application/x-ndjson").end(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (body.tools?.length) {
    response.status(400).json({
      error: "The public wiki endpoint does not accept client tools. Use the private Home Assistant control endpoint.",
    });
    return;
  }
  const researchMode = researchModeFromMessages(body.messages ?? []);
  response.locals.modelName = modelName;
  response.locals.streaming = streaming;
  const predictions: PredictionResult[] = [];
  console.info(JSON.stringify({
    event: "chat_request",
    requestId,
    model: modelName,
    messages: body.messages?.length ?? 0,
    systemMessages: body.messages?.filter(message => message.role === "system").length ?? 0,
    historyReset: historyResetIndex(body.messages ?? []) >= 0,
    researchMode,
    stream: streaming,
  }));
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  response.once("close", () => {
    if (!response.writableEnded) abortController.abort();
  });
  const sendProgress = (thinking: string) => {
    if (!streaming || response.writableEnded || response.destroyed) return;
    if (!response.headersSent) {
      response.status(200).type("application/x-ndjson");
      response.flushHeaders();
    }
    response.write(`${JSON.stringify({
      model: modelName,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: "", thinking: `${thinking}\n` },
      done: false,
    })}\n`);
  };
  const queuePosition = chatMutex.busy ? chatMutex.waiting + 1 : 0;
  if (queuePosition > 0) {
    console.info(JSON.stringify({ event: "chat_queued", requestId, position: queuePosition }));
    sendProgress(`Queued for the model (position ${queuePosition}).`);
  }
  const releaseChat = await chatMutex.acquire(abortController.signal);
  console.info(JSON.stringify({ event: "chat_started", requestId, waiting: chatMutex.waiting }));
  if (queuePosition > 0) sendProgress("Model available. Starting research.");
  try {
  let model = await lmStudio.llm.model(modelName);
  const originalRequest = parseResearchDirectives([...(body.messages ?? [])]
    .reverse()
    .find(message => message.role === "user" && typeof message.content === "string")
    ?.content ?? "").content;
  let subagentCount = 0;
  let latestResearchResult: ResearchResult | undefined;
  const runResearch = async (question: string): Promise<ResearchResult> => {
    const index = ++subagentCount;
    console.info(JSON.stringify({ event: "subagent_started", requestId, index, question }));
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const { client: subagentWikiClient } = await connectLocalWiki();
      const subagentPredictions: PredictionResult[] = [];
      const evidence: string[] = [];
      try {
        try {
          const result = await model.act([
            { role: "system", content: researchSystemPrompt },
            { role: "user", content: question },
          ], await createWikiTools(subagentWikiClient, {
            onEvidence: content => evidence.push(content),
            logContext: { requestId, subagent: index, attempt },
          }), {
            temperature: body.options?.temperature ?? config.defaultTemperature,
            maxTokens: Math.min(body.options?.num_predict ?? config.defaultMaxTokens, 1536),
            maxPredictionRounds: config.maxPredictionRounds,
            contextOverflowPolicy: "truncateMiddle",
            allowParallelToolExecution: false,
            signal: abortController.signal,
            raw: reasoningConfig(body.options?.reasoning_budget),
            onPredictionCompleted: prediction => subagentPredictions.push(prediction),
            onToolCallRequestFinalized: (round, _callId, { toolCallRequest }) => {
              console.info(JSON.stringify({
                event: "subagent_tool_call",
                requestId,
                index,
                attempt,
                round: round + 1,
                name: toolCallRequest.name,
                arguments: toolCallRequest.arguments,
              }));
            },
          });
          let answer = predictionAnswer(subagentPredictions.at(-1));
          let malformed = isMalformedResearchAnswer(answer);
          if ((!answer || malformed) && evidence.length > 0) {
            console.warn(JSON.stringify({
              event: "subagent_evidence_synthesis_started",
              requestId,
              index,
              attempt,
              reason: malformed ? "malformed_answer" : "empty_answer",
              evidenceSegments: evidence.length,
            }));
            const synthesis = await model.respond([
              { role: "system", content: evidenceSynthesisSystemPrompt },
              { role: "user", content: `Question: ${question}\n\nWikipedia evidence:\n${evidence.map((value, evidenceIndex) => `[Evidence ${evidenceIndex + 1}]\n${boundedLogText(value, 3500)}`).join("\n\n")}` },
            ], {
              temperature: 0,
              maxTokens: Math.min(body.options?.num_predict ?? config.defaultMaxTokens, 1024),
              signal: abortController.signal,
              raw: { fields: [{ key: "llm.prediction.reasoning.enableThinking", value: false }] },
            });
            const synthesizedAnswer = predictionAnswer(synthesis);
            if (synthesizedAnswer && !isMalformedResearchAnswer(synthesizedAnswer)) {
              answer = synthesizedAnswer;
              malformed = false;
            }
            console.info(JSON.stringify({
              event: "subagent_evidence_synthesis_completed",
              requestId,
              index,
              attempt,
              answerCharacters: synthesizedAnswer.length,
              malformed: isMalformedResearchAnswer(synthesizedAnswer),
            }));
          }
          const unresolved = unresolvedResearchFields(answer);
          const status = !answer || evidence.length === 0 || malformed
            ? "failed"
            : unresolved.length > 0 ? "partial" : "complete";
          console.info(JSON.stringify({
            event: "subagent_completed",
            requestId,
            index,
            attempt,
            rounds: subagentPredictions.length,
            answerCharacters: answer.length,
            answer: boundedLogText(answer),
            evidenceSegments: evidence.length,
            status,
            unresolved,
            malformed,
            executionSeconds: result.totalExecutionTimeSeconds,
          }));
          if (status !== "failed") {
            latestResearchResult = { question, answer, status, unresolved, evidence };
            return latestResearchResult;
          }
        } catch (error) {
          if (abortController.signal.aborted) throw error;
          console.warn(JSON.stringify({
            event: "subagent_failed",
            requestId,
            index,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          }));
          if (attempt < 2 && isTransientModelError(error)) {
            console.warn(JSON.stringify({ event: "subagent_model_reload", requestId, index, attempt }));
            model = await lmStudio.llm.model(modelName);
          }
        }
      } finally {
        await subagentWikiClient.close();
      }
      if (attempt < 2) {
        console.warn(JSON.stringify({ event: "subagent_retry", requestId, index, question }));
        sendProgress(`Retrying research (${attempt + 1}/2).`);
      }
    }
    return {
      question,
      answer: "No supported answer was produced.",
      status: "failed",
      unresolved: ["No supported answer was produced after two attempts."],
      evidence: [],
    };
  };
  const listSchema = z.object({
    items: z.array(z.string().min(1)).min(1).max(50),
  });
  const repairActionSchema = z.object({
    item: z.string().min(1).max(200),
    reason: z.string().min(1).max(300),
    strategy: z.enum(["record", "field_map"]),
    question: z.string().max(500),
    fieldQuestions: z.array(z.object({
      field: z.string().min(1).max(80),
      question: z.string().min(1).max(500),
    })).max(10),
  });
  const reductionReviewSchema = z.object({
    assessments: z.array(z.object({
      item: z.string().min(1).max(200),
      fields: z.array(z.object({
        field: z.string().min(1).max(80),
        satisfied: z.boolean(),
        reason: z.string().min(1).max(300),
      })).max(10),
    })).max(50),
    retries: z.array(repairActionSchema).max(10),
    additions: z.array(repairActionSchema).max(10),
    exclusions: z.array(z.object({
      item: z.string().min(1).max(200),
      reason: z.string().min(1).max(300),
    })).max(10),
  });
  const compactResults = (results: Array<ResearchResult & { item: string }>) => results.map(result => ({
    item: result.item,
    question: result.question,
    answer: result.answer,
    status: result.status,
    unresolved: result.unresolved,
    evidence: result.evidence.slice(0, 1).map(value => boundedLogText(value, 800)),
  }));
  const tools = createResearchTools({
    mode: researchMode,
    progress: sendProgress,
    observe: (event, details) => console.info(JSON.stringify({ event, requestId, ...details })),
    research: async question => runResearch(question),
    discover: async question => {
      const source = await runResearch(question);
      if (source.evidence.length === 0) throw new Error("List research produced no fetched evidence");
      const extraction = await model.respond([
        { role: "system", content: listExtractionPrompt },
        { role: "user", content: `Original user request: ${originalRequest}\n\nList question: ${question}\n\nGrounded research answer:\n${source.answer}\n\nFetched evidence:\n${source.evidence.join("\n\n---\n\n")}` },
      ], {
        temperature: 0,
        maxTokens: 2048,
        structured: listSchema,
        signal: abortController.signal,
        raw: { fields: [{ key: "llm.prediction.reasoning.enableThinking", value: false }] },
      });
      const items = normalizeDiscoveredItems(extraction.parsed.items);
      console.info(JSON.stringify({ event: "research_list_created", requestId, count: items.length, items }));
      return {
        items,
        context: `Grounded discovery answer:\n${source.answer}\n\nDiscovery evidence:\n${source.evidence.join("\n\n---\n\n")}`,
      };
    },
    reduce: async (question, results, requiredFields, discoveryContext) => {
      console.info(JSON.stringify({
        event: "research_repair_review_started",
        requestId,
        inputCount: results.length,
        question,
        requiredFields,
      }));
      let review: z.infer<typeof reductionReviewSchema> = { assessments: [], retries: [], additions: [], exclusions: [] };
      try {
        let coverageIssues: string[] = [];
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const reviewPrediction = await model.respond([
            { role: "system", content: reduceReviewSystemPrompt },
            { role: "user", content: `Reduction question: ${question}\n\nRequired fields:\n${JSON.stringify(requiredFields)}\n\nRetained discovery context:\n${boundedLogText(discoveryContext, 4000)}\n\nMapped records:\n${JSON.stringify(compactResults(results))}${coverageIssues.length > 0 ? `\n\nThe previous review was rejected because coverage was incomplete:\n${coverageIssues.join("\n")}\nReturn exactly one assessment per mapped item and one field assessment per required field.` : ""}` },
          ], {
            temperature: 0,
            maxTokens: repairReviewMaxTokens(results.length, requiredFields.length),
            structured: reductionReviewSchema,
            signal: abortController.signal,
            raw: { fields: [{ key: "llm.prediction.reasoning.enableThinking", value: false }] },
          });
          const candidate = reviewPrediction.parsed;
          coverageIssues = repairReviewCoverageIssues(candidate, results, requiredFields);
          if (coverageIssues.length === 0) {
            review = candidate;
            break;
          }
          console.warn(JSON.stringify({
            event: "research_repair_review_incomplete",
            requestId,
            attempt,
            issues: coverageIssues,
          }));
          if (attempt === 2) review = completeRepairReviewCoverage(candidate, results, requiredFields);
        }
      } catch (error) {
        if (abortController.signal.aborted) throw error;
        console.warn(JSON.stringify({
          event: "research_repair_review_failed",
          requestId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      console.info(JSON.stringify({ event: "research_repair_review_completed", requestId, review }));

      review = addAssessmentRepairs(review, requiredFields);

      const repairBudget = repairCallBudget(results.length, requiredFields.length);
      const requiredFieldNames = requiredFields.map(field => field.name);
      const { excludedKeys, actions: repairActions, plannedCalls } = buildRepairPlan(results, review, requiredFieldNames, repairBudget);
      const resultByItem = new Map(results.map(result => [result.item.toLocaleLowerCase(), result]));
      const repairedResults = results.filter(result => !excludedKeys.has(result.item.toLocaleLowerCase()));
      let repairCalls = 0;
      console.info(JSON.stringify({
        event: "research_repair_started",
        requestId,
        excludedItems: Array.from(excludedKeys),
        plannedCount: repairActions.length,
        plannedCalls,
        repairBudget,
        actions: repairActions,
      }));
      for (const [index, action] of repairActions.entries()) {
        if (repairCalls >= repairBudget) break;
        sendProgress(`Repairing ${action.item} (${index + 1}/${repairActions.length}).`);
        let repaired: ResearchResult & { item: string };
        const fieldQuestions = action.strategy === "field_map" ? action.fieldQuestions : [];
        if (fieldQuestions.length > 0) {
          console.info(JSON.stringify({
            event: "research_recursive_map_started",
            requestId,
            item: action.item,
            fieldCount: fieldQuestions.length,
            fields: fieldQuestions.map(fieldQuestion => fieldQuestion.field),
          }));
          const fieldResults: FieldResearchResult[] = [];
          for (const fieldQuestion of fieldQuestions) {
            const fieldResult = await runResearch(fieldQuestion.question);
            repairCalls += 1;
            fieldResults.push({ field: fieldQuestion.field, question: fieldQuestion.question, result: fieldResult });
          }
          const existing = resultByItem.get(action.item.toLocaleLowerCase());
          repaired = existing
            ? mergeFieldResults(existing, fieldResults)
            : reduceFieldResults(action.item, fieldResults);
          console.info(JSON.stringify({
            event: "research_recursive_map_completed",
            requestId,
            item: action.item,
            status: repaired.status,
            unresolved: repaired.unresolved,
            fieldCount: fieldResults.length,
          }));
        } else {
          const repairQuestion = action.question || resultByItem.get(action.item.toLocaleLowerCase())?.question;
          if (!repairQuestion) continue;
          repaired = { item: action.item, ...await runResearch(repairQuestion) };
          repairCalls += 1;
        }
        const existingIndex = repairedResults.findIndex(result => result.item.toLocaleLowerCase() === action.item.toLocaleLowerCase());
        if (existingIndex >= 0) repairedResults[existingIndex] = repaired;
        else repairedResults.push(repaired);
        console.info(JSON.stringify({
          event: "research_repair_recorded",
          requestId,
          kind: action.kind,
          item: action.item,
          status: repaired.status,
          unresolved: repaired.unresolved,
          evidenceSegments: repaired.evidence.length,
        }));
      }
      console.info(JSON.stringify({
        event: "research_repair_completed",
        requestId,
        repairCalls,
        outputCount: repairedResults.length,
        records: repairedResults.map(result => ({ item: result.item, status: result.status })),
      }));

      console.info(JSON.stringify({ event: "research_reduce_started", requestId, inputCount: repairedResults.length, question }));
      const prediction = await model.respond([
        { role: "system", content: reduceSystemPrompt },
        { role: "user", content: `Reduction question: ${question}\n\nRequired fields:\n${JSON.stringify(requiredFields)}\n\nRetained discovery context:\n${boundedLogText(discoveryContext, 4000)}\n\nMapped results:\n${JSON.stringify(compactResults(repairedResults))}` },
      ], {
        temperature: body.options?.temperature ?? config.defaultTemperature,
        maxTokens: Math.min(body.options?.num_predict ?? config.defaultMaxTokens, 1536),
        signal: abortController.signal,
        raw: reasoningConfig(body.options?.reasoning_budget),
      });
      const answer = predictionAnswer(prediction);
      console.info(JSON.stringify({
        event: "research_reduce_completed",
        requestId,
        inputCount: repairedResults.length,
        answerCharacters: answer.length,
        answer: boundedLogText(answer),
      }));
      return answer || "No supported reduction was produced.";
    },
  });
  let executionSeconds = 0;
  let fallbackAnswer: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    predictions.length = 0;
    try {
      const result = await model.act(chatMessages(body.messages ?? [], researchMode), tools, {
        temperature: body.options?.temperature ?? config.defaultTemperature,
        maxTokens: body.options?.num_predict ?? config.defaultMaxTokens,
        maxPredictionRounds: config.maxPredictionRounds,
        topKSampling: body.options?.top_k,
        topPSampling: body.options?.top_p,
        minPSampling: body.options?.min_p,
        repeatPenalty: body.options?.repeat_penalty,
        allowParallelToolExecution: false,
        signal: abortController.signal,
        raw: reasoningConfig(body.options?.reasoning_budget),
        onPredictionCompleted: prediction => predictions.push(prediction),
        onToolCallRequestFinalized: (round, _callId, { toolCallRequest }) => {
          console.info(JSON.stringify({
            event: "lmstudio_tool_call",
            requestId,
            attempt,
            round: round + 1,
            name: toolCallRequest.name,
            arguments: toolCallRequest.arguments,
          }));
        },
        handleInvalidToolRequest: (error, toolCallRequest) => {
          console.warn(JSON.stringify({
            event: "lmstudio_invalid_tool_call",
            requestId,
            attempt,
            error: error.message,
            request: toolCallRequest,
          }));
          if (toolCallRequest) return error.message;
          throw error;
        },
      });
      executionSeconds = result.totalExecutionTimeSeconds;
      break;
    } catch (error) {
      if (abortController.signal.aborted) throw error;
      const retryable = isTransientModelError(error);
      console.warn(JSON.stringify({
        event: "chat_attempt_failed",
        requestId,
        attempt,
        retryable,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (retryable && attempt < 2) {
        sendProgress("Model interrupted. Reloading and continuing research.");
        model = await lmStudio.llm.model(modelName);
        continue;
      }
      if (latestResearchResult) {
        fallbackAnswer = latestResearchResult.answer;
        console.warn(JSON.stringify({
          event: "chat_evidence_fallback",
          requestId,
          attempt,
          answerCharacters: fallbackAnswer.length,
          evidenceSegments: latestResearchResult.evidence.length,
        }));
        break;
      }
      throw new Error(publicResearchFailureMessage);
    }
  }
    const payload = fallbackAnswer
      ? directOllamaResponse(modelName, fallbackAnswer)
      : ollamaResponse(body, modelName, predictions, executionSeconds);
    console.info(JSON.stringify({
      event: "chat_completed",
      requestId,
      model: modelName,
      rounds: predictions.length,
      answerCharacters: payload.message.content.length,
      doneReason: payload.done_reason,
    }));
    if (!streaming) {
      response.json(payload);
    } else {
      if (!response.headersSent) response.status(200).type("application/x-ndjson");
      response.end(`${JSON.stringify(payload)}\n`);
    }
  } finally {
    releaseChat();
    console.info(JSON.stringify({ event: "chat_released", requestId, waiting: chatMutex.waiting }));
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  if (response.headersSent) {
    response.end(`${JSON.stringify({
      model: response.locals.modelName,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: publicResearchFailureMessage },
      done: true,
      done_reason: "error",
    })}\n`);
    return;
  }
  response.status(503).json({ error: publicResearchFailureMessage });
});

app.listen(config.port, "0.0.0.0", () => {
  console.info(`LM Studio gateway listening on ${config.port}`);
});

const controlApp = createControlGateway({
  lmStudioHttpUrl: config.lmStudioHttpUrl,
  lmStudioApiKey: config.lmStudioApiKey,
  apiKey: config.controlGatewayApiKey,
  defaultModel: config.defaultModel,
  defaultTemperature: config.defaultTemperature,
  defaultMaxTokens: config.defaultMaxTokens,
  mutex: chatMutex,
});

controlApp.listen(config.controlPort, "0.0.0.0", () => {
  if (config.controlGatewayApiKey === config.gatewayApiKey) {
    console.warn("CONTROL_GATEWAY_API_KEY is unset; the private control listener is using GATEWAY_API_KEY.");
  }
  console.info(`LM Studio Home Assistant control gateway listening on ${config.controlPort}`);
});