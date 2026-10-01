import { rawFunctionTool, type Tool } from "@lmstudio/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = (content as Array<{ type: string; text?: string }>)
    .filter(item => item.type === "text" && item.text)
    .map(item => item.text as string);
  return texts.length > 0 ? texts.join("\n") : JSON.stringify(result);
}

async function callMcp(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
  logContext: Record<string, unknown>,
) {
  console.info(JSON.stringify({ event: "wiki_tool_call", ...logContext, name, arguments: arguments_ }));
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = resultText(result);
  console.info(JSON.stringify({ event: "wiki_tool_result", ...logContext, name, characters: text.length, isError: result.isError === true }));
  if (result.isError) return { error: text };
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error(`${name} returned invalid JSON`);
  }
}

export async function connectLocalWiki(): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({ name: "home-assistant-lmstudio-gateway", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.localWikiMcpUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${config.localWikiMcpAuthToken}` },
    },
  });
  await client.connect(transport);
  return { client, transport };
}

export async function createWikiTools(
  client: Client,
  options: {
    onEvidence?: (content: string) => void;
    logContext?: Record<string, unknown>;
  } = {},
): Promise<Tool[]> {
  const { tools } = await client.listTools();
  return tools.map(definition => rawFunctionTool({
    name: definition.name,
    description: definition.description ?? definition.name,
    parametersJsonSchema: definition.inputSchema,
    implementation: async arguments_ => {
      const parsed = await callMcp(client, definition.name, arguments_, options.logContext ?? {});
      if (definition.name === "wiki_fetch" && typeof parsed.content === "string") {
        options.onEvidence?.(parsed.content);
      }
      return parsed;
    },
  }));
}