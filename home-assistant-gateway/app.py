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
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "wcamaralopes/bonsai-27b:latest")
GATEWAY_API_KEY = os.environ["GATEWAY_API_KEY"]
OPENZIM_MCP_URL = os.environ.get("OPENZIM_MCP_URL", "http://openzim-mcp:8000/mcp")
OPENZIM_MCP_AUTH_TOKEN = os.environ["OPENZIM_MCP_AUTH_TOKEN"]
MCP_TOOL_NAMES = set(json.loads(os.environ.get("MCP_TOOL_NAMES", '["wiki_search", "wiki_fetch"]')))
MAX_TOOL_ROUNDS = int(os.environ.get("MAX_TOOL_ROUNDS", "24"))
MAX_WIKI_SEARCHES = int(os.environ.get("MAX_WIKI_SEARCHES", "4"))
MAX_WIKI_FETCHES = int(os.environ.get("MAX_WIKI_FETCHES", "2"))
TIMEOUT = httpx.Timeout(600.0, connect=10.0)
MCP_TOOL_TIMEOUT_SECONDS = int(os.environ.get("MCP_TOOL_TIMEOUT_SECONDS", "300"))
WIKI_SYSTEM_PROMPT = """Answer using only the provided local Wikipedia tools.
Silently identify the exact claim in the question, preserving every qualifier and relation.
Search with short, title-oriented phrases. If results are weak, reformulate instead of repeating a query.
Fetch the most relevant result and verify that its text directly supports the exact claim.
Do not substitute a related claim, rely on memory, or infer a negative or universal claim from incomplete results.
Use one tool call at a time, with at most four searches and two fetches.
As soon as the evidence is sufficient, answer. When the tool budget is exhausted, answer with the best supported conclusion and state any uncertainty.
Return only a concise answer, without narrating the search process."""

app = FastAPI(title="Home Assistant Offline Wikipedia Gateway")
logger = logging.getLogger("uvicorn.error")


def require_auth(authorization: str | None, x_api_key: str | None) -> None:
    supplied_key = x_api_key
    if authorization and authorization.lower().startswith("bearer "):
        supplied_key = authorization[7:]
    if not supplied_key or not hmac.compare_digest(supplied_key, GATEWAY_API_KEY):
        raise HTTPException(status_code=401, detail="Invalid gateway API key")


def ollama_tools(mcp_tools: list, state: dict) -> list[dict]:
    exhausted = set()
    if state["searches"] >= MAX_WIKI_SEARCHES:
        exhausted.add("wiki_search")
    if state["fetches"] >= MAX_WIKI_FETCHES:
        exhausted.add("wiki_fetch")
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": tool.inputSchema,
            },
        }
        for tool in mcp_tools
        if tool.name in MCP_TOOL_NAMES and tool.name not in exhausted
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
    elif name == "wiki_fetch":
        state["fetches"] += 1
    elif name not in MCP_TOOL_NAMES:
        return json.dumps({"error": f"Unknown tool: {name}"})

    result = await asyncio.wait_for(
        session.call_tool(name, arguments),
        timeout=MCP_TOOL_TIMEOUT_SECONDS,
    )
    return mcp_text(result)


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
    mcp_headers = {"Authorization": f"Bearer {OPENZIM_MCP_AUTH_TOKEN}"}

    async with streamablehttp_client(OPENZIM_MCP_URL, headers=mcp_headers) as streams:
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            mcp_tools = (await session.list_tools()).tools
            available_tools = {tool.name for tool in mcp_tools}
            if not MCP_TOOL_NAMES.issubset(available_tools):
                raise HTTPException(status_code=503, detail="Required Wikipedia tools are unavailable")
            tool_state = {"searches": 0, "fetches": 0}

            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                for tool_round in range(MAX_TOOL_ROUNDS + 1):
                    tools = ollama_tools(mcp_tools, tool_state)
                    payload = {
                        "model": model,
                        "messages": messages,
                        "stream": False,
                        "tools": tools,
                        "options": {
                            "num_ctx": 8192,
                            "temperature": 0,
                            "num_predict": 1024,
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
                        raise HTTPException(status_code=502, detail="Maximum MCP tool rounds exceeded")

                    messages.append(message)
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
                            "Wiki tool result: round=%d name=%s chars=%d searches=%d fetches=%d",
                            tool_round + 1,
                            name,
                            len(tool_result),
                            tool_state["searches"],
                            tool_state["fetches"],
                        )
                        messages.append(
                            {
                                "role": "tool",
                                "tool_name": name,
                                "content": tool_result,
                            }
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