# Session Notes

Last updated: 2026-09-18

## Goal

Run an offline Wikipedia assistant stack with Docker:

1. Kiwix serves a local Wikipedia ZIM.
2. LocalWiki MCP searches and fetches Kiwix content.
3. LM Studio runs the Home Assistant model on the host GPUs.
4. A Node/TypeScript gateway exposes an authenticated Ollama-compatible API and uses LM Studio SDK `.act()` for parent planning and clean-context Wikipedia researchers.

## Current Architecture

```text
Home Assistant
    -> home-assistant-gateway :11435
    -> LM Studio :1234 (host)
        -> LocalWiki MCP :8080 (internal)
            -> Kiwix :8080 (internal; host 127.0.0.1:8081)

OpenZIM MCP :8000 (standalone general-purpose integration)
```

Project location: `D:\wikibot`

Wikipedia archive: `D:\wikipedia\wikipedia_en_all_maxi_2026-02.zim`

## Hardware and Runtime

- Windows with Docker Desktop/WSL2 Linux containers.
- Quadro K1200, 4 GB, compute capability 5.0.
- GTX 1650 SUPER, 4 GB, compute capability 7.5.
- LM Studio 1.3.3.0 serves its API on `0.0.0.0:1234`.
- `nemotron-3-nano-4b` is validated at 32,768 context with full GPU offload.
- `granite-4.2-8b` is stable at 12,288 context and 80% GPU offload; full offload causes CUDA OOM during inference.
- Keep model loads and benchmarks sequential.
- Do not print `.env`; it contains authentication secrets.

## Services

- Kiwix: `ghcr.io/kiwix/kiwix-tools:3.8.2`
- OpenZIM MCP: `ghcr.io/cameronrye/openzim-mcp:3.3.3`
- Home Assistant gateway: local Node 22/TypeScript image using `@lmstudio/sdk` 1.4.0
- LocalWiki MCP: local Node/TypeScript image

All relevant services were healthy after the latest deployment.

## LocalWiki MCP

Source: <https://github.com/johnterickson/lmstudio-localwiki.git>

Cloned under `localwiki-mcp`. Upstream commit `46066d5` adds recursive nested-table Markdown conversion. Local commit `17ab80b` (`Raise default search result limit`) is rebased on top and changes the standalone server default from 5 to 25; the parent repository records that nested commit.

```text
17ab80b Raise default search result limit
46066d5 Fix nested table Markdown conversion
```

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

The parent `.act()` receives `research_question` plus request-scoped `research_list`, `research_map`, and `research_reduce` tools. List discovery extracts from both the grounded answer and fetched evidence and stores validated canonical names plus discovery context behind `D1`. Map expands every `{item}` placeholder, declares generic user-derived field requirements, carries bounded discovery context into each researcher, and stores `complete`, `partial`, or `failed` records behind `M1`. Reduce requires one assessment per record and field before its structured repair review. Any unsatisfied assessment deterministically becomes a field map if no explicit retry exists. Repair may also exclude accidental records, add missing entities, or retry a whole record; all work shares an eight-call budget. Researchers run serially and cannot recursively delegate beyond this orchestrator-owned field pass. Child answers require fetched evidence, and empty, no-evidence, or terminal tool-call answers are retried once with another clean context. Researchers use `truncateMiddle` under context pressure; non-cancellation prediction failures degrade to failed records rather than aborting the map.

For set-filter questions, aggregate research is contractually first. `research_list` with purpose `set_filter_fallback` is blocked unless the latest aggregate result is partial or failed. Repeated-attribute questions use purpose `entity_attributes` and proceed directly to list-map-reduce.

An abort-aware FIFO mutex serializes complete `/api/chat` workloads across callers. Streaming callers receive queue-position and start notifications. A live two-client test showed request 1 enter `chat_started`, request 2 receive `chat_queued` at position 1, and no second model workload begin before release.

Contexts are normally bounded: the parent retains tool handles/counts rather than full datasets, and each researcher starts with only its policy plus one atomic question. A researcher can still grow through up to 12 search/section/fetch rounds, so `truncateMiddle` remains a fallback for pathological loops rather than the normal path.

Within a researcher, search paths become request-scoped article handles (`A1`, `A2`), and section IDs become request-scoped handles (`S1`, `S2`). Handles preserve search result and article document order; they do not contain relevance judgments. The gateway resolves handles back to exact LocalWiki arguments internally.

Each search now returns up to 25 results, matching the successful LM Studio LocalWiki condition. For the MLB benchmark query, this exposes `List of Major League Baseball franchise postseason droughts` at result 21.

LM Studio `.act()` owns prediction rounds, tool-call parsing, reasoning history, and tool-result continuation at both levels. The gateway logs parent and child calls, closes every MCP client, shares request cancellation with children, and returns the parent prediction in Ollama response shape. It removes LM Studio's internal synthetic reasoning separator from visible answers.

The gateway request defaults are:

- Up to 25 results per search; no separate number-of-searches or fetch cap
- 24 `.act()` prediction rounds
- `nemotron-3-nano-4b` by default
- Temperature 0.2
- 2,048 tokens per prediction round unless the client overrides `options.num_predict`
- Optional per-request `options.reasoning_budget`; unset by default and mapped to LM Studio's raw `llm.prediction.reasoning.budgetTokens` KV field
- Serial tool execution
- No benchmark response-header deadline

The gateway implements `/api/chat`, `/api/tags`, `/api/show`, `/api/version`, and `/api/ps`. Bearer tokens and `x-api-key` are accepted. Streaming requests receive incremental NDJSON `message.thinking` status records for discovery, map progress, retry, and reduction, then one final answer record. Home Assistant's Ollama adapter maps these to `thinking_content`; frontend visibility depends on the active conversation UI.

The parent prompt selects direct aggregate research or a list-map-reduce pipeline, requires evidence-only synthesis, and prevents model-managed copying of entity lists. The researcher prompt requires `wiki_search` -> `wiki_sections` -> `wiki_fetch`, exact A-number and S-number handle use, explicit support for every requested field, and biography-lead retrieval for birth dates.

## Historical Ollama Matrix and LM Studio Parity

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

## LM Studio SDK Validation

The Node rewrite validated the orchestration hypothesis. With the same Nemotron Q4_K_M model, 32,768 context, full GPU offload, and generic prompt, `.act()` completed the search -> sections -> fetch path and correctly answered that the Seattle Mariners are the only active MLB team never to reach the World Series.

Granite Q4_K_M is downloaded as `granite-4.2-8b`. At 80% GPU offload it completed five valid calls through the decisive `World Series record by team or franchise, 1903-present` table. Its first benchmark client disconnected at Node's default five-minute response-header deadline while server-side generation continued; the benchmark now uses `node:http` without that deadline. Final Granite grading remains pending.

The exact pending Qwen artifact is `unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf`, approximately 16.5 GB. Do not substitute Qwen3.5 27B. Download, load, and test it only after Granite is idle.

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
- `home-assistant-gateway/src/server.ts`: Ollama-compatible LM Studio `.act()` gateway
- `home-assistant-gateway/src/wikiTools.ts`: request-scoped LocalWiki tool adapter
- `home-assistant-gateway/src/benchmark.ts`: reproducible authenticated benchmark client
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

Set-Location D:\wikibot\home-assistant-gateway
npm run build
Set-Location D:\wikibot\localwiki-mcp
npm run build
```

Run one benchmark from the gateway container:

```powershell
Set-Location D:\wikibot
docker compose exec -T home-assistant-gateway `
  node dist/benchmark.js nemotron-3-nano-4b --num-predict 2048 --temperature 0.2
```

Capture its tool trace by recording an ISO UTC timestamp immediately before the request, then:

```powershell
docker compose logs --since $timestamp --timestamps --no-color home-assistant-gateway |
  Select-String 'lmstudio_tool_call|wiki_tool_call|wiki_tool_result|lmstudio_invalid_tool_call'
```

## Repository State and Cautions

- The Node gateway rewrite and rebased LocalWiki pointer were committed in parent commit `f72a308`.
- Do not revert unrelated changes.
- `localwiki-mcp` was cloned with nested `.git` metadata. Decide whether to preserve it as a submodule-like checkout or remove the nested metadata before a future parent commit.
- The upstream LocalWiki project is GPLv3 and its `LICENSE` is retained.
- `package.json` may still report ISC and should eventually be reconciled with the upstream GPLv3 license.
- Built/generated `dist` files are regenerated by `npm run build`.
- OpenZIM remains deployed as a standalone general-purpose MCP service, but the Home Assistant gateway does not adapt `zim_search` or `zim_get`.

## Lessons Learned

- Similar tool names over a different backend were not behaviorally equivalent. Bonsai needed the original LocalWiki/Kiwix search and parsing behavior for an apples-to-apples comparison.
- MCP transport success does not imply useful semantic search behavior.
- Small models may fail before tool execution, so first-tool compliance must be distinguished from query quality and final synthesis.
- Search results cannot prove a negative or universal claim merely because they are incomplete.
- Keep model experiments sequential; the GPUs cannot fairly serve concurrent benchmark requests.
- Use the checked-in Node benchmark client rather than inline shell/Python scripts. Several ad hoc runs were invalid due to environment propagation, authentication, shell-state errors, or client timeouts.
