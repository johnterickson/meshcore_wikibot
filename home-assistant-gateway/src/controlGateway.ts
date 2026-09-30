import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { AsyncMutex } from "./asyncMutex.js";

type JsonObject = Record<string, unknown>;

export type OllamaToolCall = {
	id?: string;
	function: {
		name: string;
		arguments?: JsonObject | string;
	};
};

export type OllamaMessage = {
	role?: string;
	content?: string;
	thinking?: string;
	tool_calls?: OllamaToolCall[];
	tool_call_id?: string;
	tool_name?: string;
};

export type OllamaChatBody = {
	model?: string;
	messages?: OllamaMessage[];
	tools?: JsonObject[];
	stream?: boolean;
	format?: string | JsonObject | null;
	keep_alive?: number | string;
	think?: boolean | string;
	options?: {
		temperature?: number;
		num_predict?: number;
		top_k?: number;
		top_p?: number;
		min_p?: number;
		repeat_penalty?: number;
		seed?: number;
		stop?: string | string[];
		num_ctx?: number;
	};
};

type OpenAiToolCall = {
	index?: number;
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
};

type OpenAiChunk = {
	model?: string;
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning?: string | null;
			reasoning_content?: string | null;
			tool_calls?: OpenAiToolCall[];
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
};

type OpenAiCompletion = {
	model?: string;
	choices?: Array<{
		message?: {
			content?: string | null;
			reasoning?: string | null;
			reasoning_content?: string | null;
			tool_calls?: OpenAiToolCall[];
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
};

export type ControlGatewayOptions = {
	lmStudioHttpUrl: string;
	lmStudioApiKey?: string;
	apiKey: string;
	defaultModel: string;
	defaultTemperature: number;
	defaultMaxTokens: number;
	mutex: AsyncMutex;
};

function secureEqual(expected: string, supplied: string | undefined): boolean {
	if (!supplied) return false;
	const expectedBuffer = Buffer.from(expected);
	const suppliedBuffer = Buffer.from(supplied);
	return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function authorized(request: Request, apiKey: string): boolean {
	const authorization = request.header("authorization");
	const supplied = authorization?.toLowerCase().startsWith("bearer ")
		? authorization.slice(7)
		: request.header("x-api-key");
	return secureEqual(apiKey, supplied);
}

function requireAuth(apiKey: string) {
	return (request: Request, response: Response, next: NextFunction) => {
		if (!authorized(request, apiKey)) {
			response.status(401).json({ error: "Invalid control gateway API key" });
			return;
		}
		next();
	};
}

function toolArguments(value: JsonObject | string | undefined): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value ?? {});
}

function ollamaArguments(value: string | undefined): JsonObject {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as JsonObject
			: {};
	} catch {
		return {};
	}
}

export function toOpenAiMessages(messages: OllamaMessage[]): JsonObject[] {
	const pendingToolCallIds: string[] = [];
	return messages
		.filter(message => typeof message.role === "string")
		.map((message, messageIndex) => {
			if (message.role === "assistant" && message.tool_calls?.length) {
				const toolCalls = message.tool_calls.map((toolCall, toolIndex) => {
					const id = toolCall.id || `call_${messageIndex}_${toolIndex}`;
					pendingToolCallIds.push(id);
					return {
						id,
						type: "function",
						function: {
							name: toolCall.function.name,
							arguments: toolArguments(toolCall.function.arguments),
						},
					};
				});
				return {
					role: "assistant",
					content: message.content || null,
					tool_calls: toolCalls,
				};
			}
			if (message.role === "tool") {
				return {
					role: "tool",
					content: message.content ?? "",
					tool_call_id: message.tool_call_id || pendingToolCallIds.shift() || `call_${messageIndex}_0`,
					...(message.tool_name ? { name: message.tool_name } : {}),
				};
			}
			return {
				role: message.role,
				content: message.content ?? "",
			};
		});
}

export function summarizeControlHistory(messages: OllamaMessage[]) {
	return {
		requestedTools: messages.flatMap(message =>
			message.role === "assistant"
				? (message.tool_calls ?? []).map(toolCall => toolCall.function.name)
				: []),
		toolResults: messages
			.filter(message => message.role === "tool")
			.map(message => {
				try {
					const result = JSON.parse(message.content ?? "") as unknown;
					if (result === null || typeof result !== "object" || Array.isArray(result)) {
						return { parsed: true, dataType: typeof result, hasError: false, dataKeys: [] };
					}
					const envelope = result as JsonObject;
					const data = envelope.data;
					return {
						parsed: true,
						dataType: Array.isArray(data) ? "array" : data === null ? "null" : typeof data,
						hasError: Boolean(envelope.error),
						dataKeys: data !== null && typeof data === "object" && !Array.isArray(data)
							? Object.keys(data as JsonObject).slice(0, 20)
							: [],
					};
				} catch {
					return { parsed: false, dataType: "text", hasError: false, dataKeys: [] };
				}
			}),
	};
}

function responseFormat(format: OllamaChatBody["format"]): JsonObject | undefined {
	if (!format) return undefined;
	if (format === "json") return { type: "json_object" };
	if (typeof format === "object") {
		return {
			type: "json_schema",
			json_schema: {
				name: "home_assistant_response",
				strict: true,
				schema: format,
			},
		};
	}
	return undefined;
}

export function toOpenAiChatRequest(
	body: OllamaChatBody,
	defaults: Pick<ControlGatewayOptions, "defaultModel" | "defaultTemperature" | "defaultMaxTokens">,
): JsonObject {
	const options = body.options ?? {};
	const format = responseFormat(body.format);
	return {
		model: body.model || defaults.defaultModel,
		messages: toOpenAiMessages(body.messages ?? []),
		stream: body.stream !== false,
		temperature: options.temperature ?? defaults.defaultTemperature,
		max_tokens: options.num_predict ?? defaults.defaultMaxTokens,
		...(options.top_k !== undefined ? { top_k: options.top_k } : {}),
		...(options.top_p !== undefined ? { top_p: options.top_p } : {}),
		...(options.min_p !== undefined ? { min_p: options.min_p } : {}),
		...(options.repeat_penalty !== undefined ? { repeat_penalty: options.repeat_penalty } : {}),
		...(options.seed !== undefined ? { seed: options.seed } : {}),
		...(options.stop !== undefined ? { stop: options.stop } : {}),
		...(body.tools?.length ? { tools: body.tools } : {}),
		...(format ? { response_format: format } : {}),
	};
}

function ollamaToolCalls(toolCalls: OpenAiToolCall[] | undefined): OllamaToolCall[] {
	return (toolCalls ?? [])
		.filter(toolCall => toolCall.function?.name)
		.map(toolCall => ({
			function: {
				name: toolCall.function?.name as string,
				arguments: ollamaArguments(toolCall.function?.arguments),
			},
		}));
}

function doneReason(finishReason: string | null | undefined): string {
	return finishReason === "length" ? "length" : "stop";
}

function ollamaChunk(model: string, message: JsonObject, done: boolean, extra: JsonObject = {}): JsonObject {
	return {
		model,
		created_at: new Date().toISOString(),
		message: { role: "assistant", ...message },
		done,
		...extra,
	};
}

export class OpenAiStreamAccumulator {
	private readonly calls = new Map<number, Required<Pick<OpenAiToolCall, "id">> & {
		function: { name: string; arguments: string };
	}>();
	private finishReason: string | null | undefined;
	private promptTokens: number | undefined;
	private completionTokens: number | undefined;
	private model: string;

	constructor(model: string) {
		this.model = model;
	}

	consume(chunk: OpenAiChunk): JsonObject[] {
		if (chunk.model) this.model = chunk.model;
		if (chunk.usage) {
			this.promptTokens = chunk.usage.prompt_tokens;
			this.completionTokens = chunk.usage.completion_tokens;
		}
		const choice = chunk.choices?.[0];
		if (!choice) return [];
		if (choice.finish_reason) this.finishReason = choice.finish_reason;
		const delta = choice.delta;
		if (!delta) return [];
		for (const toolCall of delta.tool_calls ?? []) {
			const index = toolCall.index ?? 0;
			const current = this.calls.get(index) ?? {
				id: "",
				function: { name: "", arguments: "" },
			};
			current.id += toolCall.id ?? "";
			current.function.name += toolCall.function?.name ?? "";
			current.function.arguments += toolCall.function?.arguments ?? "";
			this.calls.set(index, current);
		}
		const output: JsonObject[] = [];
		if (delta.reasoning_content || delta.reasoning) {
			output.push(ollamaChunk(this.model, {
				content: "",
				thinking: delta.reasoning_content || delta.reasoning,
			}, false));
		}
		if (delta.content) output.push(ollamaChunk(this.model, { content: delta.content }, false));
		return output;
	}

	finish(): JsonObject {
		const toolCalls = ollamaToolCalls(Array.from(this.calls.entries())
			.sort(([left], [right]) => left - right)
			.map(([, toolCall]) => toolCall));
		return ollamaChunk(this.model, {
			content: "",
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		}, true, {
			done_reason: doneReason(this.finishReason),
			...(this.promptTokens !== undefined ? { prompt_eval_count: this.promptTokens } : {}),
			...(this.completionTokens !== undefined ? { eval_count: this.completionTokens } : {}),
		});
	}
}

export function toOllamaCompletion(completion: OpenAiCompletion, requestedModel: string): JsonObject {
	const choice = completion.choices?.[0];
	const message = choice?.message;
	const toolCalls = ollamaToolCalls(message?.tool_calls);
	return ollamaChunk(completion.model || requestedModel, {
		content: message?.content ?? "",
		...(message?.reasoning_content || message?.reasoning
			? { thinking: message.reasoning_content || message.reasoning }
			: {}),
		...(toolCalls.length ? { tool_calls: toolCalls } : {}),
	}, true, {
		done_reason: doneReason(choice?.finish_reason),
		...(completion.usage?.prompt_tokens !== undefined
			? { prompt_eval_count: completion.usage.prompt_tokens }
			: {}),
		...(completion.usage?.completion_tokens !== undefined
			? { eval_count: completion.usage.completion_tokens }
			: {}),
	});
}

async function* ssePayloads(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const events = buffer.split(/\r?\n\r?\n/);
		buffer = events.pop() ?? "";
		for (const event of events) {
			const payload = event.split(/\r?\n/)
				.filter(line => line.startsWith("data:"))
				.map(line => line.slice(5).trimStart())
				.join("\n");
			if (payload) yield payload;
		}
		if (done) break;
	}
	const payload = buffer.split(/\r?\n/)
		.filter(line => line.startsWith("data:"))
		.map(line => line.slice(5).trimStart())
		.join("\n");
	if (payload) yield payload;
}

function upstreamHeaders(apiKey: string | undefined): Record<string, string> {
	return {
		"content-type": "application/json",
		...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
	};
}

export function createControlGateway(options: ControlGatewayOptions) {
	const app = express();
	let requestSequence = 0;
	const baseUrl = options.lmStudioHttpUrl.replace(/\/$/, "");
	const headers = upstreamHeaders(options.lmStudioApiKey);

	app.use(express.json({ limit: "1mb" }));

	const fetchModels = async (signal?: AbortSignal) => {
		const upstream = await fetch(`${baseUrl}/v1/models`, { headers, signal });
		if (!upstream.ok) throw new Error(`LM Studio model list failed with HTTP ${upstream.status}`);
		return await upstream.json() as { data?: Array<{ id?: string }> };
	};

	app.get("/health", async (_request, response) => {
		try {
			await fetchModels();
			response.json({ status: true, backend: "lmstudio", mode: "home-assistant-control" });
		} catch (error) {
			response.status(503).json({ status: false, backend: "lmstudio", error: String(error) });
		}
	});

	app.use("/api", requireAuth(options.apiKey));

	app.get("/api/version", (_request, response) => {
		response.json({ version: "lmstudio-openai-control-adapter-1.0.0" });
	});

	app.get("/api/tags", async (_request, response) => {
		const models = await fetchModels();
		response.json({
			models: (models.data ?? []).filter(model => model.id).map(model => ({
				name: model.id,
				model: model.id,
			})),
		});
	});

	app.get("/api/ps", async (_request, response) => {
		const models = await fetchModels();
		response.json({
			models: (models.data ?? []).filter(model => model.id).map(model => ({
				name: model.id,
				model: model.id,
			})),
		});
	});

	app.post("/api/show", async (request, response) => {
		const requested = request.body?.model ?? request.body?.name;
		const models = await fetchModels();
		if (!(models.data ?? []).some(model => model.id === requested)) {
			response.status(404).json({ error: `Model not found: ${requested}` });
			return;
		}
		response.json({
			details: { family: "lmstudio" },
			capabilities: ["completion", "tools", "thinking"],
		});
	});

	app.post("/api/chat", async (request: Request<unknown, unknown, OllamaChatBody>, response) => {
		const requestId = ++requestSequence;
		const body = request.body ?? {};
		const model = body.model || options.defaultModel;
		const streaming = body.stream !== false;
		const abortController = new AbortController();
		request.once("aborted", () => abortController.abort());
		response.once("close", () => {
			if (!response.writableEnded) abortController.abort();
		});
		console.info(JSON.stringify({
			event: "control_chat_request",
			requestId,
			model,
			messages: body.messages?.length ?? 0,
			tools: body.tools?.length ?? 0,
			history: summarizeControlHistory(body.messages ?? []),
			stream: streaming,
		}));
		const release = await options.mutex.acquire(abortController.signal);
		console.info(JSON.stringify({ event: "control_chat_started", requestId, waiting: options.mutex.waiting }));
		try {
			const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify(toOpenAiChatRequest(body, options)),
				signal: abortController.signal,
			});
			if (!upstream.ok) {
				const details = await upstream.text();
				response.status(upstream.status).json({ error: details || upstream.statusText });
				return;
			}
			if (!streaming) {
				const completion = await upstream.json() as OpenAiCompletion;
				const payload = toOllamaCompletion(completion, model);
				response.json(payload);
				const choice = completion.choices?.[0];
				console.info(JSON.stringify({
					event: "control_chat_completed",
					requestId,
					model,
					requestedTools: (choice?.message?.tool_calls ?? [])
						.map(toolCall => toolCall.function?.name)
						.filter(Boolean),
					answerCharacters: choice?.message?.content?.length ?? 0,
				}));
				return;
			}
			if (!upstream.body) throw new Error("LM Studio returned an empty stream");
			response.status(200).type("application/x-ndjson");
			response.flushHeaders();
			const accumulator = new OpenAiStreamAccumulator(model);
			for await (const payload of ssePayloads(upstream.body)) {
				if (payload === "[DONE]") break;
				const chunk = JSON.parse(payload) as OpenAiChunk;
				for (const output of accumulator.consume(chunk)) {
					response.write(`${JSON.stringify(output)}\n`);
				}
			}
			const finalPayload = accumulator.finish();
			response.end(`${JSON.stringify(finalPayload)}\n`);
			const finalMessage = finalPayload.message as JsonObject;
			console.info(JSON.stringify({
				event: "control_chat_completed",
				requestId,
				model,
				requestedTools: ((finalMessage.tool_calls as OllamaToolCall[] | undefined) ?? [])
					.map(toolCall => toolCall.function.name),
			}));
		} finally {
			release();
			console.info(JSON.stringify({ event: "control_chat_released", requestId, waiting: options.mutex.waiting }));
		}
	});

	app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
		console.error(error);
		if (response.headersSent) {
			response.end();
			return;
		}
		response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
	});

	return app;
}