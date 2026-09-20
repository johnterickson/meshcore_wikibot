import { tool, type Tool } from "@lmstudio/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { config } from "./config.js";

type Article = { path: string; title: string };
type Section = { article: string; path: string; id: string; title: string };

type WikiState = {
  articles: Map<string, Article>;
  articlePaths: Map<string, string>;
  sections: Map<string, Section>;
  sectionIds: Map<string, string>;
};

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
  const state: WikiState = {
    articles: new Map(),
    articlePaths: new Map(),
    sections: new Map(),
    sectionIds: new Map(),
  };

  const wikiSearch = tool({
    name: "wiki_search",
    description: "Search local Wikipedia. Returns short article handles such as A1.",
    parameters: { query: z.string().min(1).describe("Concise search terms") },
    implementation: async ({ query }) => {
      const parsed = await callMcp(client, "wiki_search", { query }, options.logContext ?? {});
      if (parsed.error) return `Error: ${parsed.error}`;
      const lines = ["Articles (source order; handles do not indicate relevance):"];
      for (const item of parsed.results ?? []) {
        if (!item.path) continue;
        let handle = state.articlePaths.get(item.path);
        if (!handle) {
          handle = `A${state.articles.size + 1}`;
          state.articlePaths.set(item.path, handle);
          state.articles.set(handle, { path: item.path, title: item.title ?? item.path });
        }
        lines.push(`${handle}: ${item.title ?? item.path}${item.summary ? ` - ${item.summary}` : ""}`);
      }
      if (parsed.hint) lines.push(String(parsed.hint));
      return lines.join("\n");
    },
  });

  const wikiSections = tool({
    name: "wiki_sections",
    description: "List sections of one search result. Returns short section handles such as S1.",
    parameters: { article: z.string().min(1).describe("Article handle from wiki_search") },
    implementation: async ({ article }) => {
      const selected = state.articles.get(article);
      if (!selected) return JSON.stringify({ error: `Unknown article handle: ${article}` });
      const parsed = await callMcp(client, "wiki_sections", { path: selected.path }, options.logContext ?? {});
      if (parsed.error) return `Error: ${parsed.error}`;
      const lines = [`Sections in ${article} (document order; handles do not indicate relevance):`];
      for (const item of parsed.sections ?? []) {
        const key = `${article}\u0000${item.id}`;
        let handle = state.sectionIds.get(key);
        if (!handle) {
          handle = `S${state.sections.size + 1}`;
          state.sectionIds.set(key, handle);
          state.sections.set(handle, {
            article,
            path: selected.path,
            id: item.id,
            title: item.title,
          });
        }
        lines.push(`${handle}: ${item.title}`);
      }
      return lines.join("\n");
    },
  });

  const wikiFetch = tool({
    name: "wiki_fetch",
    description: "Fetch one section segment as Markdown. Use a section handle from wiki_sections.",
    parameters: {
      section: z.string().min(1).describe("Section handle from wiki_sections"),
      segment: z.number().int().min(1).default(1),
    },
    implementation: async ({ section, segment }) => {
      const selected = state.sections.get(section);
      if (!selected) return JSON.stringify({ error: `Unknown section handle: ${section}` });
      const parsed = await callMcp(client, "wiki_fetch", {
        path: selected.path,
        section: selected.id,
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