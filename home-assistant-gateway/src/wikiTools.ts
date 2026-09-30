import { tool, type Tool } from "@lmstudio/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
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

export function createWikiTools(
  client: Client,
  options: {
    onEvidence?: (content: string) => void;
    logContext?: Record<string, unknown>;
  } = {},
): Tool[] {
  const searchedPaths = new Set<string>();
  const listedSections = new Map<string, Set<string>>();

  const wikiSearch = tool({
    name: "wiki_search",
    description: "Search local Wikipedia. Returns exact article paths for wiki_sections and wiki_fetch.",
    parameters: { query: z.string().min(1).describe("Concise search terms") },
    implementation: async ({ query }) => {
      const parsed = await callMcp(client, "wiki_search", { query }, options.logContext ?? {});
      if (parsed.error) return `Error: ${parsed.error}`;
      const lines = ["Articles (source order):"];
      for (const item of parsed.results ?? []) {
        if (!item.path) continue;
        searchedPaths.add(item.path);
        lines.push(`${item.path}${item.summary ? ` | ${item.summary}` : ""}`);
      }
      if (parsed.hint) lines.push(String(parsed.hint));
      return lines.join("\n");
    },
  });

  const wikiSections = tool({
    name: "wiki_sections",
    description: "List descriptive section IDs for an exact article path from wiki_search.",
    parameters: { path: z.string().min(1).describe("Exact article path from wiki_search") },
    implementation: async ({ path }) => {
      if (!searchedPaths.has(path)) return `Error: Unknown article path: ${path}. Call wiki_search first and use an exact returned path.`;
      const parsed = await callMcp(client, "wiki_sections", { path }, options.logContext ?? {});
      if (parsed.error) return `Error: ${parsed.error}`;
      const lines = [`Sections in ${path} (document order):`];
      const sectionIds = new Set<string>();
      for (const item of parsed.sections ?? []) {
        if (!item.id) continue;
        const sectionId = String(item.id);
        sectionIds.add(sectionId);
        lines.push(sectionId);
      }
      listedSections.set(path, sectionIds);
      return lines.join("\n");
    },
  });

  const wikiFetch = tool({
    name: "wiki_fetch",
    description: "Fetch one section segment as Markdown using its exact article path and descriptive section ID.",
    parameters: {
      path: z.string().min(1).describe("Exact article path from wiki_search"),
      section: z.string().min(1).describe("Descriptive section ID from wiki_sections"),
      segment: z.number().int().min(1).default(1),
    },
    implementation: async ({ path, section, segment }) => {
      if (!searchedPaths.has(path)) return `Error: Unknown article path: ${path}. Call wiki_search first and use an exact returned path.`;
      const sections = listedSections.get(path);
      if (!sections) return `Error: Sections have not been listed for ${path}. Call wiki_sections first.`;
      if (!sections.has(section)) return `Error: Unknown section ID for ${path}: ${section}. Use an exact ID returned by wiki_sections.`;
      const parsed = await callMcp(client, "wiki_fetch", {
        path,
        section,
        segment,
      }, options.logContext ?? {});
      if (parsed.error) return `Error: ${parsed.error}`;
      const pagination = parsed.pagination ?? {};
      const content = `${parsed.content ?? JSON.stringify(parsed)}\n\n[Segment ${pagination.segment ?? 1} of ${pagination.totalSegments ?? 1}; has next: ${Boolean(pagination.hasNextSegment)}]`;
      options.onEvidence?.(content);
      return content;
    },
  });

  return [wikiSearch, wikiSections, wikiFetch];
}