# Session Notes

Last updated: 2026-09-17

## Goal

Run an offline Wikipedia assistant stack with Docker:

1. Kiwix serves a local Wikipedia ZIM.
2. LocalWiki MCP searches and fetches Kiwix content.
3. Ollama runs local models on both host NVIDIA GPUs.
4. A FastAPI gateway exposes an authenticated Ollama-compatible API to Home Assistant and orchestrates Wikipedia tools.
5. Open WebUI remains available, but it is not in the Home Assistant request path.

## Current Architecture

```text
Home Assistant
    -> home-assistant-gateway :11435
        -> Ollama :11434
        -> LocalWiki MCP :8080 (internal)
            -> Kiwix :8080 (internal; host 127.0.0.1:8081)

Open WebUI :3000
    -> Ollama
    -> OpenZIM MCP :8000 (separate legacy/general-purpose integration)
```

Project location: `D:\wikibot`

Wikipedia archive: `D:\wikipedia\wikipedia_en_all_maxi_2026-02.zim`

## Hardware and Runtime

- Windows with Docker Desktop/WSL2 Linux containers.
- Quadro K1200, 4 GB, compute capability 5.0.
- GTX 1650 SUPER, 4 GB, compute capability 7.5.
- Ollama is configured to use both GPU UUIDs from `.env`.
- Default context is 8192 tokens.
- Flash attention and q8_0 KV cache are enabled.
- Ollama handles one parallel request.
- Do not print `.env`; it contains authentication secrets.

## Services

- Kiwix: `ghcr.io/kiwix/kiwix-tools:3.8.2`
- OpenZIM MCP: `ghcr.io/cameronrye/openzim-mcp:3.3.3`
- Ollama: `ollama/ollama:0.34.0`
- Open WebUI: `ghcr.io/open-webui/open-webui:v0.11.3`
- Home Assistant gateway: local FastAPI image
- LocalWiki MCP: local Node/TypeScript image

All relevant services were healthy after the latest deployment.

## LocalWiki MCP

Source: <https://github.com/johnterickson/lmstudio-localwiki.git>

Cloned under `localwiki-mcp` at upstream commit:

```text
841ea26151dccbcd5fb3afe89c619434829c958b
```

The upstream LM Studio plugin was wrapped in a standalone authenticated Streamable HTTP MCP server. The Kiwix behavior was preserved:

- `/suggest` exact/prefix matching
- `/search` full-text results
- Kiwix HTML parsing
- Redirect handling
- Intro/full/references extraction
- Character pagination

The implementation assumes exactly one Kiwix book. Its catalog is resolved internally and cached; the model does not provide a book name.

Live MCP tools:

```json
[
  {
    "name": "wiki_search",
    "required": ["query"]
  },
  {
    "name": "wiki_fetch",
    "required": ["path"],
    "optional": ["content", "page"]
  }
]
```

`wiki_list` was completely removed from source, generated output, gateway behavior, prompts, Compose configuration, benchmark text, and documentation.

`wiki_fetch.content` accepts `intro`, `full`, or `refs` and defaults to `intro`. `page` defaults to 1.

The LocalWiki service build and live MCP discovery were validated. Both `wiki_search` and `wiki_fetch` execute successfully against Kiwix.

## Home Assistant Gateway

The gateway directly discovers LocalWiki MCP schemas with `session.list_tools()` and forwards MCP calls without translating through OpenZIM operations.

Legacy environment variable names remain for compatibility:

- `OPENZIM_MCP_URL` points to LocalWiki MCP.
- `OPENZIM_MCP_AUTH_TOKEN` authenticates LocalWiki MCP.

The gateway limits each request to:

- Four searches
- Two article fetches
- 24 model/tool rounds
- 8192-token context by default
- Temperature 0
- 1024 prediction tokens
- `repeat_last_n=64`

The publisher-supplied Bonsai value `repeat_last_n=-1` was intentionally overridden because it is invalid/problematic in this setup.

Current technique-only system prompt:

```text
Answer using only the provided local Wikipedia tools.
Silently identify the exact claim in the question, preserving every qualifier and relation.
Search with short, title-oriented phrases. If results are weak, reformulate instead of repeating a query.
Fetch the most relevant result and verify that its text directly supports the exact claim.
Do not substitute a related claim, rely on memory, or infer a negative or universal claim from incomplete results.
Use one tool call at a time, with at most four searches and two fetches.
As soon as the evidence is sufficient, answer. When the tool budget is exhausted, answer with the best supported conclusion and state any uncertainty.
Return only a concise answer, without narrating the search process.
```

## Important Files

- `compose.yaml`: service definitions and runtime settings
- `.env.example`: documented configuration defaults
- `home-assistant-gateway/app.py`: gateway orchestration
- `home-assistant-gateway/benchmark.py`: reproducible authenticated benchmark client
- `localwiki-mcp/src/toolsProvider.ts`: Kiwix search/fetch implementation
- `localwiki-mcp/src/server.ts`: standalone MCP HTTP server
- `localwiki-mcp/Dockerfile`: two-stage Node 22 image
- `MODEL_EXPERIMENTS.md`: experiment record and continuation plan

## Validation Commands

```powershell
Set-Location D:\wikibot

docker compose config --quiet
docker compose build localwiki-mcp home-assistant-gateway
docker compose up -d --force-recreate localwiki-mcp home-assistant-gateway
docker compose ps

python -m py_compile home-assistant-gateway/app.py home-assistant-gateway/benchmark.py
Set-Location D:\wikibot\localwiki-mcp
npm run build
```

Run one benchmark from the gateway container:

```powershell
Set-Location D:\wikibot
docker compose exec -T home-assistant-gateway `
  python benchmark.py qwen3:4b-instruct-2507-q4_K_M
```

Capture its tool trace by recording an ISO UTC timestamp immediately before the request, then:

```powershell
docker compose logs --since $timestamp --timestamps --no-color home-assistant-gateway |
  Select-String 'Wiki tool call|Wiki tool result|POST /api/chat'
```

## Repository State and Cautions

- The parent worktree contains accumulated uncommitted changes.
- Do not revert unrelated changes.
- Do not commit unless explicitly requested.
- `localwiki-mcp` was cloned with nested `.git` metadata. Decide whether to preserve it as a submodule-like checkout or remove the nested metadata before a future parent commit.
- The upstream LocalWiki project is GPLv3 and its `LICENSE` is retained.
- `package.json` may still report ISC and should eventually be reconciled with the upstream GPLv3 license.
- Built/generated `dist` files are regenerated by `npm run build`.
- OpenZIM remains deployed for Open WebUI/general use, but the Home Assistant gateway no longer adapts `zim_search` or `zim_get`.

## Lessons Learned

- Similar tool names over a different backend were not behaviorally equivalent. Bonsai needed the original LocalWiki/Kiwix search and parsing behavior for an apples-to-apples comparison.
- MCP transport success does not imply useful semantic search behavior.
- Small models may fail before tool execution, so first-tool compliance must be distinguished from query quality and final synthesis.
- Search results cannot prove a negative or universal claim merely because they are incomplete.
- Keep model experiments sequential; the GPUs cannot fairly serve concurrent benchmark requests.
- Use the checked-in benchmark client rather than inline shell/Python scripts. Several ad hoc runs were invalid due to environment propagation, authentication, or shell-state errors.
