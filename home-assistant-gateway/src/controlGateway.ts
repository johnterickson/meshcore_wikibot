import { timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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

export const controlSafetyPrompt = `Home Assistant control policy: Match the user's requested operation exactly. Never substitute stop, pause, toggle, open, close, turn-on, or turn-off operations for one another. A requested tool call does not prove that an action succeeded. After tool results, claim success only for entities explicitly listed in data.success and report every entity in data.failed.

After a successful state-changing action, use the supplied state-reading tool whose name ends in HassGetState to verify every affected entity before answering. For cover actions, if a state is opening or closing, check it again, with at most three state observations per entity. Claim a final open or closed state only when the latest state result explicitly reports it. If state verification is unavailable, remains moving, returns to the opposite state, or otherwise does not prove the requested final state, say the command was sent and report the observed state, but clearly state that completion was not confirmed.`;

function stateValues(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(stateValues);
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value as JsonObject).flatMap(([key, entry]) =>
		key.toLowerCase() === "state" && typeof entry === "string"
			? [entry]
			: stateValues(entry)
	);
}

export function controlVerificationStatus(messages: OllamaMessage[]) {
	let latestMutationIndex = -1;
	let latestStateCallIndex = -1;
	let stateChecks = 0;
	let stateRounds = 0;
	let latestStateCalls: OllamaToolCall[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role !== "assistant" || !message.tool_calls?.length) continue;
		const names = message.tool_calls.map(toolCall => toolCall.function.name);
		if (names.some(name => !/HassGetState$/i.test(name))) {
			latestMutationIndex = messageIndex;
			latestStateCallIndex = -1;
			stateChecks = 0;
			stateRounds = 0;
			latestStateCalls = [];
		}
		const stateCalls = message.tool_calls.filter(toolCall => /HassGetState$/i.test(toolCall.function.name));
		const checks = stateCalls.length;
		if (checks > 0 && messageIndex > latestMutationIndex) {
			latestStateCallIndex = messageIndex;
			stateChecks += checks;
			stateRounds += 1;
			latestStateCalls = stateCalls;
		}
	}

	const latestStates: string[] = [];
	const observedStates: string[] = [];
	let collectingStateResult = false;
	for (let index = latestMutationIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role === "assistant") {
			collectingStateResult = Boolean(message.tool_calls?.some(call => /HassGetState$/i.test(call.function.name)));
			continue;
		}
		if (message.role !== "tool" || !collectingStateResult) continue;
		try {
			observedStates.push(...stateValues(JSON.parse(message.content ?? "")));
		} catch {
			// Non-JSON tool results cannot prove a final state.
		}
	}
	if (latestStateCallIndex >= 0) {
		for (let index = latestStateCallIndex + 1; index < messages.length; index += 1) {
			const message = messages[index];
			if (message.role !== "tool") break;
			try {
				latestStates.push(...stateValues(JSON.parse(message.content ?? "")));
			} catch {
				// Non-JSON tool results cannot prove a final state.
			}
		}
	}
	return {
		stateChecks,
		stateRounds,
		latestStates,
		movingStates: latestStates.filter(state => /^(?:opening|closing)$/i.test(state)),
		observedStates,
		latestStateCalls,
	};
}

function requestedFinalState(messages: OllamaMessage[]): string | undefined {
	const request = [...messages]
		.reverse()
		.find(message => message.role === "user" && typeof message.content === "string")
		?.content?.toLowerCase() ?? "";
	if (/\bclose(?:d)?\b/.test(request)) return "closed";
	if (/\bopen(?:ed)?\b/.test(request)) return "open";
	if (/\b(?:turn|switch)\s+off\b/.test(request)) return "off";
	if (/\b(?:turn|switch)\s+on\b/.test(request)) return "on";
	if (/\bunlock(?:ed)?\b/.test(request)) return "unlocked";
	if (/\block(?:ed)?\b/.test(request)) return "locked";
	return undefined;
}

function toolCallEntityNames(calls: OllamaToolCall[]): string[] {
	return calls.flatMap(call => {
		const arguments_ = typeof call.function.arguments === "string"
			? ollamaArguments(call.function.arguments)
			: call.function.arguments;
		const name = arguments_?.name;
		return typeof name === "string" && name.trim() ? [name.trim()] : [];
	});
}

export function verifiedControlOutcome(messages: OllamaMessage[]): string | undefined {
	const target = requestedFinalState(messages);
	const verification = controlVerificationStatus(messages);
	if (!target || verification.stateRounds === 0 || verification.latestStates.length === 0) {
		return undefined;
	}
	if (verification.movingStates.length > 0 && verification.stateRounds < 3) {
		return undefined;
	}
	const entities = toolCallEntityNames(verification.latestStateCalls);
	const subject = entities.length > 0 ? entities.join(", ") : "the requested entities";
	const latest = verification.latestStates.join(", ");
	const enoughResults = entities.length === 0 || verification.latestStates.length >= entities.length;
	const reachedTarget = enoughResults && verification.latestStates.every(state => state.toLowerCase() === target);
	if (reachedTarget) {
		return `Command completed and verified for ${subject}. Latest observed state: ${latest}.`;
	}
	const movement = verification.observedStates.find(state => /^(?:opening|closing)$/i.test(state));
	return `Command was sent for ${subject}.${movement ? ` It was observed ${movement}.` : ""} Latest observed state: ${latest}. Requested final state ${target} was not confirmed.`;
}

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
					const resultData = data !== null && typeof data === "object" && !Array.isArray(data)
						? data as JsonObject
						: undefined;
					return {
						parsed: true,
						dataType: Array.isArray(data) ? "array" : data === null ? "null" : typeof data,
						hasError: Boolean(envelope.error),
						dataKeys: resultData
							? Object.keys(resultData).slice(0, 20)
							: [],
						successCount: Array.isArray(resultData?.success) ? resultData.success.length : undefined,
						failedCount: Array.isArray(resultData?.failed) ? resultData.failed.length : undefined,
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
		messages: [
			{ role: "system", content: controlSafetyPrompt },
			...toOpenAiMessages(body.messages ?? []),
		],
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
		const verification = controlVerificationStatus(body.messages ?? []);
		const verificationLog = {
			stateChecks: verification.stateChecks,
			stateRounds: verification.stateRounds,
			latestStates: verification.latestStates,
			movingStates: verification.movingStates,
			observedStates: verification.observedStates,
		};
		console.info(JSON.stringify({
			event: "control_chat_request",
			requestId,
			model,
			messages: body.messages?.length ?? 0,
			tools: body.tools?.length ?? 0,
			toolNames: (body.tools ?? []).map(tool => {
				const definition = tool.function;
				return definition && typeof definition === "object" && !Array.isArray(definition)
					? (definition as JsonObject).name
					: undefined;
			}).filter(name => typeof name === "string"),
			history: summarizeControlHistory(body.messages ?? []),
			verification: verificationLog,
			stream: streaming,
		}));
		if (verification.movingStates.length > 0 && verification.stateRounds < 3) {
			console.info(JSON.stringify({
				event: "control_verification_wait",
				requestId,
				milliseconds: 5000,
				stateChecks: verification.stateChecks,
				movingStates: verification.movingStates,
			}));
			await delay(5000, undefined, { signal: abortController.signal });
			const suppliedToolNames = new Set((body.tools ?? []).flatMap(tool => {
				const definition = tool.function;
				if (!definition || typeof definition !== "object" || Array.isArray(definition)) return [];
				const name = (definition as JsonObject).name;
				return typeof name === "string" ? [name] : [];
			}));
			const recheckCalls = verification.stateRounds < 3
				? verification.latestStateCalls.filter(call => suppliedToolNames.has(call.function.name))
				: [];
			if (recheckCalls.length > 0) {
				const payload = ollamaChunk(model, { content: "", tool_calls: recheckCalls }, true, { done_reason: "stop" });
				console.info(JSON.stringify({
					event: "control_verification_recheck",
					requestId,
					stateRound: verification.stateRounds + 1,
					requestedTools: recheckCalls.map(call => call.function.name),
				}));
				if (!streaming) response.json(payload);
				else response.status(200).type("application/x-ndjson").end(`${JSON.stringify(payload)}\n`);
				return;
			}
		}
		const verifiedOutcome = verifiedControlOutcome(body.messages ?? []);
		if (verifiedOutcome) {
			const payload = ollamaChunk(model, { content: verifiedOutcome }, true, { done_reason: "stop" });
			console.info(JSON.stringify({
				event: "control_verification_completed",
				requestId,
				stateChecks: verification.stateChecks,
				latestStates: verification.latestStates,
				confirmed: !/not confirmed\.$/i.test(verifiedOutcome),
			}));
			if (!streaming) response.json(payload);
			else response.status(200).type("application/x-ndjson").end(`${JSON.stringify(payload)}\n`);
			return;
		}
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