import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

test("createWikiTools forwards MCP schemas, arguments, results, and fetched evidence", async () => {
  process.env.GATEWAY_API_KEY ??= "test-gateway-key";
  process.env.LOCALWIKI_MCP_AUTH_TOKEN ??= "test-localwiki-token";
  const { createWikiTools } = await import("./wikiTools.js");
  const inputSchema = {
    type: "object" as const,
    properties: {
      path: { type: "string" },
      section_id: { type: "string", default: "" },
      section_page: { type: "integer", minimum: 1, default: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  };
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const result = {
    content: "George H. W. Bush was left-handed.",
    next: { section_id: "Other_presidents", section_page: 1 },
  };
  const client = {
    listTools: async () => ({
      tools: [{ name: "wiki_fetch", description: "Fetch an article page.", inputSchema }],
    }),
    callTool: async (request: { name: string; arguments?: Record<string, unknown> }) => {
      calls.push(request);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  } as unknown as Client;
  const evidence: string[] = [];

  const tools = await createWikiTools(client, { onEvidence: value => evidence.push(value) });
  assert.equal(tools.length, 1);
  const wikiFetch = tools[0];
  assert.equal(wikiFetch.type, "rawFunction");
  if (wikiFetch.type !== "rawFunction") return;
  assert.deepEqual(wikiFetch.parametersJsonSchema, inputSchema);

  const arguments_ = {
    path: "List_of_left-handed_presidents_of_the_United_States",
    section_id: "Left-handed_presidents_of_the_United_States",
    section_page: 1,
  };
  const returned = await wikiFetch.implementation(arguments_, {
    status: () => undefined,
    warn: () => undefined,
    signal: new AbortController().signal,
    callId: 1,
  });

  assert.deepEqual(calls, [{ name: "wiki_fetch", arguments: arguments_ }]);
  assert.deepEqual(returned, result);
  assert.deepEqual(evidence, [result.content]);
});