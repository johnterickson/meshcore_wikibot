export type ResearchMode = "query" | "map";

export type ParsedResearchDirectives = {
  content: string;
  mode: ResearchMode;
  reset: boolean;
};

export const helpMessage = "/query <question> (default); /map <question> for lists; /new resets chat. Commands can be combined.";

export function parseResearchDirectives(value: string): ParsedResearchDirectives {
  let content = value.trimStart();
  let mode: ResearchMode = "query";
  let reset = false;

  while (true) {
    const match = content.match(/^\/(new|query|map)(?=\s|$)/i);
    if (!match) break;
    const directive = match[1].toLowerCase();
    if (directive === "new") reset = true;
    else mode = directive as ResearchMode;
    content = content.slice(match[0].length).trimStart();
  }

  return { content, mode, reset };
}

export function researchModeFromMessages(
  messages: Array<{ role?: string; content?: string }>,
): ResearchMode {
  const latestUserMessage = [...messages]
    .reverse()
    .find(message => message.role === "user" && typeof message.content === "string");
  return latestUserMessage?.content
    ? parseResearchDirectives(latestUserMessage.content).mode
    : "query";
}

export function isHelpRequest(
  messages: Array<{ role?: string; content?: string }>,
): boolean {
  const latestUserMessage = [...messages]
    .reverse()
    .find(message => message.role === "user" && typeof message.content === "string");
  return latestUserMessage?.content
    ? /^\/?help$/i.test(parseResearchDirectives(latestUserMessage.content).content.trim())
    : false;
}