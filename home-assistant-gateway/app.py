import hmac
import asyncio
import json
import logging
import os

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import Response
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434").rstrip("/")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "granite4.2:8b")
DEFAULT_NUM_CTX = int(os.environ.get("OLLAMA_CONTEXT_LENGTH", "12288"))
DEFAULT_TEMPERATURE = float(os.environ.get("OLLAMA_TEMPERATURE", "0.2"))
GATEWAY_API_KEY = os.environ["GATEWAY_API_KEY"]
OPENZIM_MCP_URL = os.environ.get("OPENZIM_MCP_URL", "http://openzim-mcp:8000/mcp")
OPENZIM_MCP_AUTH_TOKEN = os.environ["OPENZIM_MCP_AUTH_TOKEN"]
MCP_TOOL_NAMES = set(json.loads(os.environ.get("MCP_TOOL_NAMES", '["wiki_search", "wiki_sections", "wiki_fetch"]')))
MAX_TOOL_ROUNDS = int(os.environ.get("MAX_TOOL_ROUNDS", "24"))
COMPACT_CONTEXT_THRESHOLD = float(os.environ.get("COMPACT_CONTEXT_THRESHOLD", "0.85"))
COMPACT_NUM_PREDICT = int(os.environ.get("COMPACT_NUM_PREDICT", "256"))
OLLAMA_KEEP_ALIVE_RAW = os.environ.get("OLLAMA_KEEP_ALIVE", "-1")
OLLAMA_KEEP_ALIVE = (
    int(OLLAMA_KEEP_ALIVE_RAW)
    if OLLAMA_KEEP_ALIVE_RAW.lstrip("-").isdigit()
    else OLLAMA_KEEP_ALIVE_RAW
)
OLLAMA_THINK_RAW = os.environ.get("OLLAMA_THINK", "low").strip().lower()
OLLAMA_THINK = {"true": True, "false": False}.get(OLLAMA_THINK_RAW, OLLAMA_THINK_RAW)
OLLAMA_REQUEST_TIMEOUT_SECONDS = float(os.environ.get("OLLAMA_REQUEST_TIMEOUT_SECONDS", "72000"))
TIMEOUT = httpx.Timeout(OLLAMA_REQUEST_TIMEOUT_SECONDS, connect=10.0)
MCP_TOOL_TIMEOUT_SECONDS = int(os.environ.get("MCP_TOOL_TIMEOUT_SECONDS", "300"))
WIKI_SYSTEM_PROMPT = """Your internal factual knowledge is limited and may be inaccurate, but you have access to an offline copy of Wikipedia through the provided tools. This is your primary source of truth: use it heavily, and do not rely on memory, other tools, or web search.

Use the intentional retrieval sequence: wiki_search, wiki_sections for a promising article, then wiki_fetch for the most relevant section. Article and section handles are short and valid only for this request. Fetch additional segments only when the current segment says another is available and the evidence is still insufficient.

Handles preserve source order and do not indicate relevance. Compare titles before choosing a handle.

Find explicit support for the precise question, preserving its qualifiers and relationships. Once the evidence is sufficient, answer concisely."""

COMPACTION_SYSTEM_PROMPT = """Compress only the retrieval work provided below. The original system and client messages are intentionally omitted and will be restored unchanged after this summary. Do not infer, restate, reinterpret, or answer the user's request. Use at most 120 words and exactly these three labeled lines: ATTEMPTED, EVIDENCE, STATUS. Preserve useful searches, tool choices, explicit evidence with its source handle, and unresolved factual uncertainty. Distinguish evidence from speculation. Treat `has next: false` as confirmation that a fetched section is complete. Omit repetition and obsolete attempts. Do not call tools or add any other text."""

MODEL_TOOL_SCHEMAS = {
    "wiki_search": {
        "description": "Search local Wikipedia. Returns short article handles such as A1.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Concise search terms"}},
            "required": ["query"],
        },
    },
    "wiki_sections": {
        "description": "List sections of one search result. Returns short section handles such as S1.",
        "parameters": {
            "type": "object",
            "properties": {"article": {"type": "string", "description": "Article handle from wiki_search"}},
            "required": ["article"],
        },
    },
    "wiki_fetch": {
        "description": "Fetch one section segment as Markdown. Use a section handle from wiki_sections.",
        "parameters": {
            "type": "object",
            "properties": {
                "section": {"type": "string", "description": "Section handle from wiki_sections"},
                "segment": {"type": "integer", "minimum": 1, "default": 1},
            },
            "required": ["section"],
        },
    },
}

app = FastAPI(title="Home Assistant Offline Wikipedia Gateway")
logger = logging.getLogger("uvicorn.error")

if not 0 <= COMPACT_CONTEXT_THRESHOLD <= 1:
    raise ValueError("COMPACT_CONTEXT_THRESHOLD must be between 0 and 1")


def without_thinking(message: dict) -> dict:
    return {key: value for key, value in message.items() if key != "thinking"}


def estimated_next_prompt_tokens(result: dict, added_messages: list[dict]) -> int | None:
    prompt_tokens = result.get("prompt_eval_count")
    if not isinstance(prompt_tokens, int):
        return None
    serialized = json.dumps(added_messages, ensure_ascii=False, separators=(",", ":"))
    return prompt_tokens + (len(serialized) + 2) // 3


def should_compact(result: dict, added_messages: list[dict], num_ctx: int) -> bool:
    if COMPACT_CONTEXT_THRESHOLD <= 0:
        return False
    estimated_tokens = estimated_next_prompt_tokens(result, added_messages)
    return (
        estimated_tokens is not None
        and estimated_tokens >= int(num_ctx * COMPACT_CONTEXT_THRESHOLD)
    )


def require_auth(authorization: str | None, x_api_key: str | None) -> None:
    supplied_key = x_api_key
    if authorization and authorization.lower().startswith("bearer "):
        supplied_key = authorization[7:]
    if not supplied_key or not hmac.compare_digest(supplied_key, GATEWAY_API_KEY):
        raise HTTPException(status_code=401, detail="Invalid gateway API key")


def ollama_tools(mcp_tools: list) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                **MODEL_TOOL_SCHEMAS[tool.name],
            },
        }
        for tool in mcp_tools
        if tool.name in MCP_TOOL_NAMES and tool.name in MODEL_TOOL_SCHEMAS
    ]


def mcp_text(result) -> str:
    texts = []
    for content in result.content:
        text = getattr(content, "text", None)
        if text:
            texts.append(text)
    if texts:
        return "\n".join(texts)
    return json.dumps(result.model_dump(mode="json", exclude_none=True))


async def call_wiki_tool(session: ClientSession, name: str, arguments: dict, state: dict) -> str:
    if name == "wiki_search":
        state["searches"] += 1
        mcp_arguments = arguments
    elif name == "wiki_sections":
        article_handle = arguments.get("article", "")
        article = state["articles"].get(article_handle)
        if not article:
            return json.dumps({"error": f"Unknown article handle: {article_handle}"})
        state["section_lists"] += 1
        mcp_arguments = {"path": article["path"]}
    elif name == "wiki_fetch":
        section_handle = arguments.get("section", "")
        section = state["sections"].get(section_handle)
        if not section:
            return json.dumps({"error": f"Unknown section handle: {section_handle}"})
        state["fetches"] += 1
        mcp_arguments = {
            "path": section["path"],
            "section": section["id"],
            "segment": arguments.get("segment", 1),
        }
    elif name not in MCP_TOOL_NAMES:
        return json.dumps({"error": f"Unknown tool: {name}"})
    else:
        return json.dumps({"error": f"Unsupported tool: {name}"})

    result = await asyncio.wait_for(
        session.call_tool(name, mcp_arguments),
        timeout=MCP_TOOL_TIMEOUT_SECONDS,
    )
    raw_result = mcp_text(result)
    try:
        parsed = json.loads(raw_result)
    except json.JSONDecodeError:
        return raw_result

    if name == "wiki_search" and isinstance(parsed.get("results"), list):
        model_results = []
        for item in parsed["results"]:
            path = item.get("path")
            if not path:
                continue
            article_handle = state["article_paths"].get(path)
            if not article_handle:
                article_handle = f"A{len(state['articles']) + 1}"
                state["article_paths"][path] = article_handle
                state["articles"][article_handle] = {"path": path, "title": item.get("title", path)}
            model_item = {"article": article_handle, "title": item.get("title", path)}
            if item.get("summary"):
                model_item["summary"] = item["summary"]
            model_results.append(model_item)
        lines = ["Articles (source order; handles do not indicate relevance):"]
        for item in model_results:
            line = f"{item['article']}: {item['title']}"
            if item.get("summary"):
                line += f" — {item['summary']}"
            lines.append(line)
        if parsed.get("hint"):
            lines.append(str(parsed["hint"]))
        return "\n".join(lines)

    if name == "wiki_sections" and isinstance(parsed.get("sections"), list):
        article_handle = arguments["article"]
        article = state["articles"][article_handle]
        model_sections = []
        for item in parsed["sections"]:
            section_key = (article_handle, item["id"])
            section_handle = state["section_ids"].get(section_key)
            if not section_handle:
                section_handle = f"S{len(state['sections']) + 1}"
                state["section_ids"][section_key] = section_handle
                state["sections"][section_handle] = {
                    "article": article_handle,
                    "path": article["path"],
                    "id": item["id"],
                    "title": item["title"],
                }
            model_sections.append({
                "section": section_handle,
                "title": item["title"],
                "level": item["level"],
            })
        lines = [f"Sections in {article_handle} (document order; handles do not indicate relevance):"]
        lines.extend(f"{item['section']}: {item['title']}" for item in model_sections)
        return "\n".join(lines)

    if name == "wiki_fetch" and isinstance(parsed.get("content"), str):
        pagination = parsed.get("pagination", {})
        tool_result = (
            f"{parsed['content']}\n\n"
            f"[Segment {pagination.get('segment', 1)} of {pagination.get('totalSegments', 1)}; "
            f"has next: {str(pagination.get('hasNextSegment', False)).lower()}]"
        )
        state["evidence"].append({"section": arguments["section"], "content": tool_result})
        state["evidence"] = state["evidence"][-2:]
        return tool_result

    return raw_result


def handle_registry(state: dict) -> str:
    articles = [
        f"- {handle}: {article['title']}"
        for handle, article in state["articles"].items()
    ]
    sections = [
        f"- {handle} ({section['article']}): {section['title']}"
        for handle, section in state["sections"].items()
    ]
    registry = "Current request-scoped handles (source order, not relevance):\n"
    if articles:
        registry += "\nArticles:\n" + "\n".join(articles)
    if sections:
        registry += "\n\nSections:\n" + "\n".join(sections)
    return registry


async def compact_tool_history(
    client: httpx.AsyncClient,
    model: str,
    messages: list[dict],
    base_messages: list[dict],
    state: dict,
) -> list[dict]:
    base_message_ids = {id(message) for message in base_messages}
    retrieval_messages = [
        message for message in messages if id(message) not in base_message_ids
    ]
    compaction_messages = [
        {"role": "system", "content": COMPACTION_SYSTEM_PROMPT},
        *retrieval_messages,
        {"role": "user", "content": "Summarize the retrieval work now."},
    ]
    response = await client.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": model,
            "messages": compaction_messages,
            "stream": False,
            "think": False,
            "keep_alive": OLLAMA_KEEP_ALIVE,
            "options": {
                "num_ctx": DEFAULT_NUM_CTX,
                "temperature": 0,
                "num_predict": COMPACT_NUM_PREDICT,
                "repeat_last_n": 64,
            },
        },
    )
    response.raise_for_status()
    summary = (response.json().get("message") or {}).get("content", "").strip()
    if not summary:
        raise RuntimeError("Compaction model returned an empty summary")
    logger.info("LLM compaction produced summary_chars=%d", len(summary))
    return [
        base_messages[0],
        {"role": "system", "content": handle_registry(state)},
        {
            "role": "assistant",
            "content": (
                "Earlier tool-work summary (advisory; the original client messages below "
                f"remain authoritative):\n{summary}"
            ),
        },
        *base_messages[1:],
    ]


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"status": True}


@app.post("/api/chat")
async def chat(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Response:
    require_auth(authorization, x_api_key)
    body = await request.json()
    model = body.get("model") or DEFAULT_MODEL
    messages = [{"role": "system", "content": WIKI_SYSTEM_PROMPT}]
    messages.extend(dict(message) for message in body.get("messages", []))
    base_messages = list(messages)
    mcp_headers = {"Authorization": f"Bearer {OPENZIM_MCP_AUTH_TOKEN}"}

    async with streamablehttp_client(OPENZIM_MCP_URL, headers=mcp_headers) as streams:
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            mcp_tools = (await session.list_tools()).tools
            available_tools = {tool.name for tool in mcp_tools}
            if not MCP_TOOL_NAMES.issubset(available_tools):
                raise HTTPException(status_code=503, detail="Required Wikipedia tools are unavailable")
            tool_state = {
                "searches": 0,
                "section_lists": 0,
                "fetches": 0,
                "articles": {},
                "article_paths": {},
                "sections": {},
                "section_ids": {},
                "evidence": [],
            }

            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                for tool_round in range(MAX_TOOL_ROUNDS + 1):
                    tools = ollama_tools(mcp_tools)
                    payload = {
                        "model": model,
                        "messages": messages,
                        "stream": False,
                        "tools": tools,
                        "think": OLLAMA_THINK,
                        "keep_alive": OLLAMA_KEEP_ALIVE,
                        "options": {
                            "num_ctx": DEFAULT_NUM_CTX,
                            "temperature": DEFAULT_TEMPERATURE,
                            "num_predict": 102400,
                            "repeat_last_n": 64,
                        },
                    }
                    for option in ("options", "format", "keep_alive", "think"):
                        if option in body:
                            payload[option] = body[option]

                    response = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
                    if response.is_error:
                        return Response(
                            content=response.content,
                            status_code=response.status_code,
                            media_type=response.headers.get("content-type", "application/json"),
                        )

                    result = response.json()
                    message = result.get("message", {})
                    tool_calls = message.get("tool_calls", [])
                    if not tool_calls:
                        break
                    if tool_round == MAX_TOOL_ROUNDS:
                        return Response(
                            content=json.dumps({"detail": "Maximum MCP tool rounds exceeded"}),
                            status_code=502,
                            media_type="application/json",
                        )

                    history_message = without_thinking(message)
                    messages.append(history_message)
                    added_messages = [history_message]
                    for tool_call in tool_calls:
                        function = tool_call.get("function", {})
                        name = function.get("name", "")
                        arguments = function.get("arguments") or {}
                        if isinstance(arguments, str):
                            try:
                                arguments = json.loads(arguments)
                            except json.JSONDecodeError as error:
                                raise HTTPException(
                                    status_code=502,
                                    detail="Model returned invalid tool arguments",
                                ) from error

                        logger.info(
                            "Wiki tool call: round=%d name=%s arguments=%s",
                            tool_round + 1,
                            name,
                            json.dumps(arguments, ensure_ascii=True, sort_keys=True),
                        )
                        tool_result = await call_wiki_tool(session, name, arguments, tool_state)
                        logger.info(
                            "Wiki tool result: round=%d name=%s chars=%d searches=%d sections=%d fetches=%d",
                            tool_round + 1,
                            name,
                            len(tool_result),
                            tool_state["searches"],
                            tool_state["section_lists"],
                            tool_state["fetches"],
                        )
                        tool_message = {
                            "role": "tool",
                            "tool_name": name,
                            "content": tool_result,
                        }
                        messages.append(tool_message)
                        added_messages.append(tool_message)

                    num_ctx = int(payload.get("options", {}).get("num_ctx", DEFAULT_NUM_CTX))
                    if should_compact(result, added_messages, num_ctx):
                        try:
                            estimated_tokens = estimated_next_prompt_tokens(result, added_messages)
                            logger.info(
                                "Context-pressure compaction after round=%d estimated_tokens=%s num_ctx=%d threshold=%.2f",
                                tool_round + 1,
                                estimated_tokens,
                                num_ctx,
                                COMPACT_CONTEXT_THRESHOLD,
                            )
                            messages = await compact_tool_history(
                                client,
                                model,
                                messages,
                                base_messages,
                                tool_state,
                            )
                            logger.info("LLM-compacted complete history after round=%d", tool_round + 1)
                        except (httpx.HTTPError, ValueError, RuntimeError) as error:
                            logger.warning(
                                "Skipping failed LLM compaction after round=%d: %s",
                                tool_round + 1,
                                error,
                            )

    media_type = "application/x-ndjson" if body.get("stream", True) else "application/json"
    content = json.dumps(result) + ("\n" if media_type == "application/x-ndjson" else "")
    return Response(content=content, media_type=media_type)


@app.api_route("/api/{path:path}", methods=["GET", "POST", "DELETE"])
async def ollama_proxy(
    path: str,
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Response:
    require_auth(authorization, x_api_key)
    body = await request.body()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.request(
            request.method,
            f"{OLLAMA_URL}/api/{path}",
            content=body or None,
            headers={"Content-Type": request.headers.get("content-type", "application/json")},
        )
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type"),
    )