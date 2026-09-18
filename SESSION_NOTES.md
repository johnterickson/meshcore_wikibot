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
- Default context is 12,288 tokens.
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

Cloned under `localwiki-mcp` at commit:

```text
4abce86 Add section-aware MCP server
```

That commit is present on `origin/main`. Local commit `571f128` (`Raise default search result limit`) changes the standalone server's default search limit from 5 to 25; the parent repository records that nested commit.

The upstream LM Studio plugin was wrapped in a standalone authenticated Streamable HTTP MCP server. The Kiwix behavior was preserved:

- `/suggest` exact/prefix matching
- `/search` full-text results
- Kiwix HTML parsing
- Redirect handling
- Section discovery
- Block-aware section segmentation

The implementation assumes exactly one Kiwix book. Its catalog is resolved internally and cached; the model does not provide a book name.

Live MCP tools:

```json
[
  {
    "name": "wiki_search",
    "required": ["query"]
  },
  {
    "name": "wiki_sections",
    "required": ["path"]
  },
  {
    "name": "wiki_fetch",
    "required": ["path", "section"],
    "optional": ["segment"]
  }
]
```

`wiki_list` was completely removed from source, generated output, gateway behavior, prompts, Compose configuration, benchmark text, and documentation.

`wiki_sections` returns the non-empty sections of an article in document order. `wiki_fetch` returns one section as native Markdown with the References section removed. `segment` defaults to 1. Segmentation keeps paragraphs and list items intact, splits tables only between rows, and repeats table headers. If an article path returns HTTP 404, underscores are replaced with spaces and matching `wiki_search` results are returned.

The LocalWiki service build and live MCP discovery were validated. All three tools execute successfully against Kiwix.

## Home Assistant Gateway

The gateway discovers LocalWiki MCP tools and presents a smaller model-facing schema. Search paths become request-scoped article handles (`A1`, `A2`), and section IDs become request-scoped handles (`S1`, `S2`). Handles preserve search result and article document order; they do not contain relevance judgments. The gateway resolves handles back to exact LocalWiki arguments internally.

Each search now returns up to 25 results, matching the successful LM Studio LocalWiki condition. For the MLB benchmark query, this exposes `List of Major League Baseball franchise postseason droughts` at result 21.

The gateway removes prior reasoning traces from model history while preserving the current response's reasoning for diagnostics. It compacts only when Ollama's measured prompt usage plus newly appended tool messages is estimated to reach 85% of the request's context window. Compaction sends only accumulated assistant/tool retrieval work to the model without tools or hidden thinking and asks it for a compact factual summary. The original gateway policy and client messages are excluded. The compacted history keeps the mechanical handle registry and treats the generated summary as advisory assistant context, then restores the exact original messages unchanged. A failed or empty compaction leaves the existing history intact.

Legacy environment variable names remain for compatibility:

- `OPENZIM_MCP_URL` points to LocalWiki MCP.
- `OPENZIM_MCP_AUTH_TOKEN` authenticates LocalWiki MCP.

The gateway request defaults are:

- Up to 25 results per search; no separate number-of-searches or fetch cap
- 24 model/tool rounds
- Granite 4.2 8B by default
- 12,288-token context by default
- Temperature 0.2
- 102,400 prediction tokens unless the client overrides it; controlled matrix runs use 2,048
- `repeat_last_n=64`
- Low-effort thinking by default (`OLLAMA_THINK=low`); clients may override it with `true`, `false`, or another supported level
- `keep_alive=-1` so the active model remains resident
- 7,200-second Ollama request and benchmark timeout for long-running diagnostics

The publisher-supplied Bonsai value `repeat_last_n=-1` was intentionally overridden because it is invalid/problematic in this setup.

LM Studio's successful Granite run enabled thinking with a separate 64-token reasoning budget. Ollama does not expose a numeric reasoning budget for this model, but Granite's installed template implements `reasoning_effort="low"`; `OLLAMA_THINK=low` is the closest available control and does not guarantee an exact 64-token limit.

Current technique-only system prompt:

```text
Your internal factual knowledge is limited and may be inaccurate, but you have access to an offline copy of Wikipedia through the provided tools. This is your primary source of truth: use it heavily, and do not rely on memory, other tools, or web search.

Use the intentional retrieval sequence: wiki_search, wiki_sections for a promising article, then wiki_fetch for the most relevant section. Article and section handles are short and valid only for this request. Fetch additional segments only when the current segment says another is available and the evidence is still insufficient.

Handles preserve source order and do not indicate relevance. Compare titles before choosing a handle.

Find explicit support for the precise question, preserving its qualifiers and relationships. Once the evidence is sufficient, answer concisely.
```

## Model Matrix and LM Studio Parity

All current gateway matrix runs use the generic MLB question, temperature 0.2, 8,192 context unless noted, 2,048 prediction tokens, and sequential execution. A wrong answer counts as failure and triggers the requested GTX-only fallback after a dual-GPU attempt.

| Model | Dual GPU | GTX-only |
| --- | --- | --- |
| `nemotron-3-nano:4b` | All 43 layers loaded, then empty warm-up timed out after five minutes | Loaded in 100.8 seconds; two 8K runs failed semantically |
| `openbmb/minicpm5-2b:q4_K_M` | Loaded fully on GPU; searched repeatedly but never listed/fetched sections | Confused article and section handles and exhausted its output budget |
| `qwen3:14b-q4_K_M` | Runner startup timed out after 313 seconds | Loaded 11/41 layers on GPU; four searches, no fetch, then exhausted 2,048 reasoning tokens |
| `mistral-nemo:12b` | Downloaded; benchmark pending | Pending if dual fails |

The successful LM Studio Nemotron trace used the same `Q4_K_M` quantization, 32,768 context, full 42-layer GPU offload, thinking enabled, 25 search results, and no compaction between section listing and fetch. It made one recoverable invalid fetch, listed raw section IDs, fetched `Longest_current_World_Series_appearance_droughts`, and answered correctly from the explicit `Seattle Mariners | Never` row.

The gateway was changed to match the three material orchestration conditions visible in that trace:

- 25 search results
- prior reasoning removed from subsequent model history
- compaction only near 85% of the active context window

A GTX-only Nemotron parity run then used 32,768 context, Boolean thinking, full GPU residency, and the same `Q4_K_M` artifact. It found the drought article and listed its sections without any compaction (`prompt_eval_count=1927`), but generated 2,048 repetitive reasoning tokens about fetching `S19` without emitting a tool call. This isolates the remaining discrepancy to same-turn reasoning/tool emission, chat template, or runtime orchestration rather than search visibility, retained reasoning, or compaction.

Raw reference transcripts committed with this checkpoint:

- `granite_success_1.txt`
- `granite_success_2.txt`
- `pagination_bug.txt`
- `qwen3.8-27b_success.txt`
- `nemotron - 2026-09-17 19.08`
- `nemotron - 2026-09-17 19.09`
- `nemotron - 2026-09-17 21.13`

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

- This checkpoint intentionally includes the accumulated gateway/configuration changes, documentation, and raw experiment transcripts.
- Do not revert unrelated changes.
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
