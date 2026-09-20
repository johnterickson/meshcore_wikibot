# Offline Wikipedia AI stack

This Docker Compose project runs:

- Kiwix Serve for every `.zim` archive under `D:\wikipedia`
- OpenZIM MCP with streamable HTTP and bearer authentication
- A Node/TypeScript Ollama-compatible Home Assistant gateway that uses LM Studio `.act()` with LocalWiki MCP tools

## Start

Docker Desktop must use the WSL 2 backend, and `docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi` must be able to see the GPU. Start LM Studio's local server on port 1234, allow network access, and load the model identifier configured by `HOME_ASSISTANT_MODEL` before using the gateway.

```powershell
docker compose pull
docker compose up -d
docker compose ps
```

Open these local endpoints:

| Service | URL |
| --- | --- |
| Kiwix | http://localhost:8081 |
| LM Studio API | http://localhost:1234 |
| OpenZIM MCP | http://localhost:8000/mcp |
| OpenZIM MCP readiness | http://localhost:8000/readyz |
| Home Assistant gateway | http://localhost:11435 |

The Home Assistant gateway listens on all host interfaces. From another device on the LAN, use `http://<this-computer-lan-ip>:11435` for the authenticated Wiki-enabled gateway. LM Studio must listen on `0.0.0.0:1234` so the gateway container can reach it through `host.docker.internal`; expose both endpoints only on trusted networks.

## Models

The validated gateway default is `nvidia/nemotron-3-nano-4b`, loaded in LM Studio at 32,768 context on the GTX 1650 SUPER. `granite-4.2-8b` also runs at 12,288 context but needs partial GPU offload; full offload runs out of CUDA memory during inference.

The gateway defaults to temperature 0.2, a 2,048-token prediction limit, and at most 24 `.act()` prediction rounds. Clients may override common sampling options and the per-round prediction limit. The optional `options.reasoning_budget` extension reproduces LM Studio GUI reasoning presets through the SDK's raw KV configuration; it is unset by default. Tool arguments and bounded result metadata are logged without article bodies.

## Home Assistant

In Home Assistant, add the **Ollama** integration with:

| Field | Value |
| --- | --- |
| URL | `http://<this-computer-lan-ip>:11435` |
| API key | `HOME_ASSISTANT_GATEWAY_API_KEY` from `.env` |
| Model | Loaded LM Studio identifier, such as `nvidia/nemotron-3-nano-4b` |
| Control Home Assistant | Off |

The gateway gives the parent planner four request-scoped tools: `research_question`, `research_list`, `research_map`, and `research_reduce`. List discovery stores normalized unique entity names plus grounded discovery context behind a dataset handle such as `D1`; map declares the required fields, carries bounded discovery context into each clean researcher, and stores generic `complete`, `partial`, or `failed` records behind `M1`. Before final synthesis, reduce requires a per-record assessment of every field against its user-derived semantic requirement. Unsatisfied assessments deterministically become field-level repairs even if the model omits an explicit retry. Reduce may also exclude accidental records, add clearly missing entities, or retry a complete record. All repair strategies share an eight-call limit. The model never has to copy long lists between rounds, and the gateway validates map completion. Researchers run serially to avoid concurrent load on the single model.

Set-filter enumeration is a fallback, not the first strategy. A `set_filter_fallback` list request is rejected until aggregate `research_question` has returned a partial or failed result. Attribute-oriented enumeration uses the separate `entity_attributes` purpose.

A gateway-wide abort-aware FIFO mutex permits only one top-level `/api/chat` model workload at a time. Additional streaming requests receive their queue position and start only after the active request releases the model. Disconnecting while queued removes that request without starting inference.

Inside each researcher, article handles (`A1`, `A2`) and section handles (`S1`, `S2`) replace long Kiwix paths and anchors. Handles are isolated to that researcher, follow result/document order, and do not encode relevance. Section content is returned as native Markdown in block-aware segments; nested tables are converted recursively, tables split only between rows, and split segments repeat their headers. An answer is accepted only after a successful `wiki_fetch`; empty answers, no-evidence answers, and terminal tool-call markup are rejected and retried once with fresh context and handles. Child context overflow truncates older middle turns while retaining the policy and original question. Other child prediction failures are isolated to that item, retried once, then recorded as failed instead of aborting the entire map.

The compatibility surface includes `/api/chat`, `/api/tags`, `/api/show`, `/api/version`, and `/api/ps`. Bearer authentication and `x-api-key` are supported. Streaming requests receive Ollama-compatible NDJSON `message.thinking` progress records for discovery, each map item, retries, and reduction, followed by one final `done:true` answer. Non-streaming requests still receive one JSON response.

Begin a user message with `/new` to discard earlier conversation history, for example `/new Which active MLB teams have never been to the World Series?`. The most recent `/new` remains the history boundary when Home Assistant sends later follow-up messages.

## Verify and operate

```powershell
Invoke-RestMethod http://localhost:1234/v1/models
Invoke-RestMethod http://localhost:8081/catalog/v2/entries
Invoke-RestMethod http://localhost:8000/readyz
Invoke-RestMethod http://localhost:11435/health
docker compose logs -f
```

Run the reproducible gateway benchmark from the container. It intentionally has no response-header deadline because local multi-round inference can take more than five minutes.

```powershell
docker compose exec -T home-assistant-gateway `
	node dist/benchmark.js nvidia/nemotron-3-nano-4b --question "<question>" --num-predict 2048 --temperature 0.2
```

Benchmark JSON escapes non-ASCII characters so PowerShell redirection and `Tee-Object` preserve output without code-page corruption. JSON parsers decode those escapes back to the original text.

For the saved Granite condition that limits private reasoning to 64 tokens:

```powershell
docker compose exec -T home-assistant-gateway `
	node dist/benchmark.js granite-4.2-8b --question "<question>" --num-predict 2048 --temperature 0.2 --reasoning-budget 64
```

Configuration and secrets are in the ignored `.env` file. `.env.example` documents every setting. OpenZIM MCP persists its writable response cache under the ignored `cache/openzim-mcp` directory. Its response cache holds 500 entries for four hours, with a 64 MiB libzim cluster cache and 2048-entry dirent cache for the large Wikipedia archive. To change the ZIM folder or host ports, edit `.env` and run `docker compose up -d` again.

Set `OPENZIM_MCP_LOG_LEVEL=DEBUG` in `.env` and recreate the OpenZIM container to include function names and debug-level operation details in `docker compose logs openzim-mcp`. Use `INFO` for normal operation because debug logging is verbose and does not provide a built-in stage profiler.

To stop the Docker services, run `docker compose down`. LM Studio models are managed outside Docker. The MCP cache is stored in the host `cache/openzim-mcp` directory and is not removed by Docker Compose.