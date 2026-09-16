import hmac
import json
import logging
import os

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import Response
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434").rstrip("/")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "qwen3.5:4b")
GATEWAY_API_KEY = os.environ["GATEWAY_API_KEY"]
OPENZIM_MCP_URL = os.environ.get("OPENZIM_MCP_URL", "http://openzim-mcp:8000/mcp")
OPENZIM_MCP_AUTH_TOKEN = os.environ["OPENZIM_MCP_AUTH_TOKEN"]
MCP_TOOL_NAMES = set(json.loads(os.environ.get("MCP_TOOL_NAMES", '["zim_query"]')))
MAX_TOOL_ROUNDS = int(os.environ.get("MAX_TOOL_ROUNDS", "8"))
TIMEOUT = httpx.Timeout(600.0, connect=10.0)
WIKI_SYSTEM_PROMPT = """/no_think
Use the Offline Wikipedia tools to research factual questions.
Continue calling search and article tools until the answer is supported by article content.
Do not call or report server health unless the user asks about server or archive health.
Give a concise final answer and identify the offline Wikipedia article used."""

app = FastAPI(title="Home Assistant Offline Wikipedia Gateway")
logger = logging.getLogger("uvicorn.error")


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
                "description": tool.description or "",
                "parameters": tool.inputSchema,
            },
        }
        for tool in mcp_tools
        if tool.name in MCP_TOOL_NAMES
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
    mcp_headers = {"Authorization": f"Bearer {OPENZIM_MCP_AUTH_TOKEN}"}

    async with streamablehttp_client(OPENZIM_MCP_URL, headers=mcp_headers) as streams:
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            tools = ollama_tools((await session.list_tools()).tools)

            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                for tool_round in range(MAX_TOOL_ROUNDS + 1):
                    payload = {
                        "model": model,
                        "messages": messages,
                        "stream": False,
                        "tools": tools,
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

                        logger.info("Calling OpenZIM MCP tool: %s", name)
                        tool_result = await session.call_tool(name, arguments)
                        logger.info("Completed OpenZIM MCP tool: %s", name)
                        messages.append(
                            {
                                "role": "tool",
                                "tool_name": name,
                                "content": json.dumps(
                                    tool_result.model_dump(mode="json", exclude_none=True)
                                ),
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