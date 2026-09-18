function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? "8080"),
  lmStudioBaseUrl: process.env.LM_STUDIO_BASE_URL ?? "ws://host.docker.internal:1234",
  lmStudioHttpUrl: (process.env.LM_STUDIO_HTTP_URL ?? "http://host.docker.internal:1234").replace(/\/$/, ""),
  defaultModel: process.env.DEFAULT_MODEL ?? "nemotron-3-nano-4b",
  defaultTemperature: Number(process.env.LM_STUDIO_TEMPERATURE ?? "0.2"),
  defaultMaxTokens: Number(process.env.LM_STUDIO_MAX_TOKENS ?? "2048"),
  maxPredictionRounds: Number(process.env.MAX_TOOL_ROUNDS ?? "24"),
  gatewayApiKey: required("GATEWAY_API_KEY"),
  localWikiMcpUrl: process.env.LOCALWIKI_MCP_URL ?? "http://localwiki-mcp:8080/mcp",
  localWikiMcpAuthToken: required("LOCALWIKI_MCP_AUTH_TOKEN"),
};

export const wikiSystemPrompt = `Your internal factual knowledge is limited and may be inaccurate, but you have access to an offline copy of Wikipedia through the provided tools. This is your primary source of truth: use it heavily, and do not rely on memory, other tools, or web search.

Use the intentional retrieval sequence: wiki_search, wiki_sections for a promising article, then wiki_fetch for the most relevant section. Article and section handles are short and valid only for this request. Fetch additional segments only when the current segment says another is available and the evidence is still insufficient.

Handles preserve source order and do not indicate relevance. Compare titles before choosing a handle.

Find explicit support for the precise question, preserving its qualifiers and relationships. Once the evidence is sufficient, answer concisely.`;