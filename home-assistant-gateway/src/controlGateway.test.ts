import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { AsyncMutex } from "./asyncMutex.js";
import { createControlGateway, OpenAiStreamAccumulator, summarizeControlHistory, toOllamaCompletion, toOpenAiChatRequest, toOpenAiMessages } from "./controlGateway.js";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("toOpenAiMessages reconstructs tool call IDs for Ollama history", () => {
	assert.deepEqual(toOpenAiMessages([
		{ role: "system", content: "Control only exposed entities." },
		{ role: "user", content: "Turn on the desk lamp." },
		{
			role: "assistant",
			content: "",
			tool_calls: [{
				function: {
					name: "HassTurnOn",
					arguments: { name: "Desk lamp" },
				},
			}],
		},
		{ role: "tool", content: '{"success":true}' },
	]), [
		{ role: "system", content: "Control only exposed entities." },
		{ role: "user", content: "Turn on the desk lamp." },
		{
			role: "assistant",
			content: null,
			tool_calls: [{
				id: "call_2_0",
				type: "function",
				function: {
					name: "HassTurnOn",
					arguments: '{"name":"Desk lamp"}',
				},
			}],
		},
		{ role: "tool", content: '{"success":true}', tool_call_id: "call_2_0" },
	]);
});

test("toOpenAiChatRequest forwards HA tools and compatible generation options", () => {
	const tool = {
		type: "function",
		function: {
			name: "HassTurnOff",
			description: "Turns off an exposed entity",
			parameters: { type: "object", properties: { name: { type: "string" } } },
		},
	};
	const request = toOpenAiChatRequest({
		model: "test-model",
		messages: [{ role: "user", content: "Turn off the kitchen light" }],
		tools: [tool],
		stream: true,
		keep_alive: -1,
		think: false,
		options: {
			temperature: 0.1,
			num_predict: 256,
			num_ctx: 8192,
			top_p: 0.9,
		},
	}, {
		defaultModel: "default-model",
		defaultTemperature: 0.2,
		defaultMaxTokens: 2048,
	});

	assert.deepEqual(request, {
		model: "test-model",
		messages: [{ role: "user", content: "Turn off the kitchen light" }],
		stream: true,
		temperature: 0.1,
		max_tokens: 256,
		top_p: 0.9,
		tools: [tool],
	});
});

test("OpenAiStreamAccumulator joins fragmented tool calls", () => {
	const accumulator = new OpenAiStreamAccumulator("requested-model");
	const [thinkingChunk] = accumulator.consume({
		model: "loaded-model",
		choices: [{ delta: { reasoning_content: "I should use a tool." } }],
	});
	assert.match(thinkingChunk.created_at as string, /^\d{4}-\d{2}-\d{2}T/);
	delete thinkingChunk.created_at;
	assert.deepEqual(thinkingChunk, {
		model: "loaded-model",
		message: { role: "assistant", content: "", thinking: "I should use a tool." },
		done: false,
	});

	accumulator.consume({
		choices: [{
			delta: {
				tool_calls: [{
					index: 0,
					id: "tool-1",
					type: "function",
					function: { name: "HassTurn", arguments: '{"na' },
				}],
			},
		}],
	});
	accumulator.consume({
		choices: [{
			delta: {
				tool_calls: [{ index: 0, function: { name: "On", arguments: 'me":"Desk lamp"}' } }],
			},
			finish_reason: "tool_calls",
		}],
		usage: { prompt_tokens: 100, completion_tokens: 12 },
	});

	const final = accumulator.finish();
	assert.equal(final.model, "loaded-model");
	assert.equal(final.done, true);
	assert.equal(final.done_reason, "stop");
	assert.equal(final.prompt_eval_count, 100);
	assert.equal(final.eval_count, 12);
	assert.deepEqual(final.message, {
		role: "assistant",
		content: "",
		tool_calls: [{
			function: {
				name: "HassTurnOn",
				arguments: { name: "Desk lamp" },
			},
		}],
	});
});

test("toOllamaCompletion converts a non-streamed tool response", () => {
	const result = toOllamaCompletion({
		model: "loaded-model",
		choices: [{
			finish_reason: "tool_calls",
			message: {
				content: null,
				tool_calls: [{
					id: "tool-1",
					type: "function",
					function: { name: "HassGetState", arguments: '{"name":"Thermostat"}' },
				}],
			},
		}],
		usage: { prompt_tokens: 80, completion_tokens: 10 },
	}, "requested-model");

	assert.equal(result.model, "loaded-model");
	assert.equal(result.done, true);
	assert.deepEqual(result.message, {
		role: "assistant",
		content: "",
		tool_calls: [{
			function: {
				name: "HassGetState",
				arguments: { name: "Thermostat" },
			},
		}],
	});
});

test("control gateway authenticates and streams complete Ollama tool calls", async () => {
	let upstreamRequest: Record<string, unknown> | undefined;
	const upstream = createServer((request, response) => {
		if (request.url === "/v1/models") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
			return;
		}
		if (request.url !== "/v1/chat/completions") {
			response.statusCode = 404;
			response.end();
			return;
		}
		const chunks: Buffer[] = [];
		request.on("data", chunk => chunks.push(chunk));
		request.on("end", () => {
			upstreamRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${JSON.stringify({
				model: "test-model",
				choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "HassTurn", arguments: '{"na' } }] } }],
			})}\n\n`);
			response.write(`data: ${JSON.stringify({
				choices: [{
					delta: { tool_calls: [{ index: 0, function: { name: "On", arguments: 'me":"Desk lamp"}' } }] },
					finish_reason: "tool_calls",
				}],
			})}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	const upstreamUrl = await listen(upstream);
	const app = createControlGateway({
		lmStudioHttpUrl: upstreamUrl,
		apiKey: "private-key",
		defaultModel: "test-model",
		defaultTemperature: 0.2,
		defaultMaxTokens: 256,
		mutex: new AsyncMutex(),
	});
	const gateway = createServer(app);
	const gatewayUrl = await listen(gateway);
	try {
		const unauthorized = await fetch(`${gatewayUrl}/api/tags`);
		assert.equal(unauthorized.status, 401);

		const tool = {
			type: "function",
			function: {
				name: "HassTurnOn",
				description: "Turn on an exposed entity",
				parameters: { type: "object", properties: { name: { type: "string" } } },
			},
		};
		const response = await fetch(`${gatewayUrl}/api/chat`, {
			method: "POST",
			headers: {
				authorization: "Bearer private-key",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "test-model",
				messages: [{ role: "user", content: "Turn on the desk lamp" }],
				tools: [tool],
				stream: true,
			}),
		});
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
		const lines = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
		assert.equal(lines.length, 1);
		assert.deepEqual(lines[0].message.tool_calls, [{
			function: { name: "HassTurnOn", arguments: { name: "Desk lamp" } },
		}]);
		assert.equal(lines[0].done, true);
		assert.deepEqual(upstreamRequest?.tools, [tool]);
		assert.deepEqual(upstreamRequest?.messages, [{ role: "user", content: "Turn on the desk lamp" }]);
	} finally {
		await close(gateway);
		await close(upstream);
	}
});

test("summarizeControlHistory reports tool flow without values", () => {
	assert.deepEqual(summarizeControlHistory([
		{
			role: "assistant",
			tool_calls: [{ function: { name: "HassGetState", arguments: { name: "Garage door" } } }],
		},
		{
			role: "tool",
			content: JSON.stringify({ data: { success: [{ name: "Garage door", state: "open" }] }, error: null }),
		},
	]), {
		requestedTools: ["HassGetState"],
		toolResults: [{
			parsed: true,
			dataType: "object",
			hasError: false,
			dataKeys: ["success"],
		}],
	});
});