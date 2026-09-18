import { timingSafeEqual } from "node:crypto";
import { LMStudioClient, type ChatMessageInput, type PredictionResult } from "@lmstudio/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, wikiSystemPrompt } from "./config.js";
import { connectLocalWiki, createWikiTools } from "./wikiTools.js";

type OllamaMessage = {
  role?: string;
  content?: string;
};

type ChatBody = {
  model?: string;
  messages?: OllamaMessage[];
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

function chatMessages(messages: OllamaMessage[]): ChatMessageInput[] {
  const supportedRoles = new Set(["system", "user", "assistant"]);
  return [
    { role: "system", content: wikiSystemPrompt },
    ...messages
      .filter(message => message.role && supportedRoles.has(message.role) && typeof message.content === "string")
      .map(message => ({
        role: message.role as "system" | "user" | "assistant",
        content: message.content,
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

function ollamaResponse(body: ChatBody, modelName: string, predictions: PredictionResult[], seconds: number) {
  const finalPrediction = predictions.at(-1);
  const answer = finalPrediction?.nonReasoningContent
    .replace(/__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_[^_]+__/g, "")
    .trim() ?? "";
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
  const body = request.body ?? {};
  const modelName = body.model || config.defaultModel;
  const predictions: PredictionResult[] = [];
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  response.once("close", () => {
    if (!response.writableEnded) abortController.abort();
  });
  const { client: wikiClient } = await connectLocalWiki();
  try {
    const model = await lmStudio.llm.model(modelName);
    const result = await model.act(chatMessages(body.messages ?? []), createWikiTools(wikiClient), {
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
          round: round + 1,
          name: toolCallRequest.name,
          arguments: toolCallRequest.arguments,
        }));
      },
      handleInvalidToolRequest: (error, toolCallRequest) => {
        console.warn(JSON.stringify({
          event: "lmstudio_invalid_tool_call",
          error: error.message,
          request: toolCallRequest,
        }));
        if (toolCallRequest) return error.message;
        throw error;
      },
    });
    const payload = ollamaResponse(body, modelName, predictions, result.totalExecutionTimeSeconds);
    if (body.stream === false) {
      response.json(payload);
    } else {
      response.type("application/x-ndjson").send(`${JSON.stringify(payload)}\n`);
    }
  } finally {
    await wikiClient.close();
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});

app.listen(config.port, "0.0.0.0", () => {
  console.info(`LM Studio gateway listening on ${config.port}`);
});