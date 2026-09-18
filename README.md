# Offline Wikipedia AI stack

This Docker Compose project runs:

- Kiwix Serve for every `.zim` archive under `D:\wikipedia`
- OpenZIM MCP with streamable HTTP and bearer authentication
- Ollama for Open WebUI
- Open WebUI connected to Ollama and pre-seeded with the OpenZIM MCP server
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
| Open WebUI | http://localhost:3000 |
| Kiwix | http://localhost:8081 |
| Ollama API | http://localhost:11434 |
| LM Studio API | http://localhost:1234 |
| OpenZIM MCP | http://localhost:8000/mcp |
| OpenZIM MCP readiness | http://localhost:8000/readyz |
| Home Assistant gateway | http://localhost:11435 |

Ollama and the Home Assistant gateway listen on all host interfaces. From another device on the LAN, use `http://<this-computer-lan-ip>:11434` for raw Ollama or `http://<this-computer-lan-ip>:11435` for the authenticated Wiki-enabled gateway. LM Studio must listen on `0.0.0.0:1234` so the gateway container can reach it through `host.docker.internal`; expose it only on trusted networks.

Ollama uses both the Quadro K1200 and GTX 1650 SUPER identified by `OLLAMA_GPU_DEVICE_IDS` in `.env`. Flash attention, a quantized KV cache, single-request concurrency, zero configured GPU overhead, and `LLAMA_ARG_FIT_TARGET=128` maximize the model layers that fit in combined VRAM. `OLLAMA_CONTEXT_LENGTH=12288` keeps Granite at the validated context; requests may still override it with `options.num_ctx`. `OLLAMA_KEEP_ALIVE=-1` keeps the active model loaded between tool rounds and requests. The 128 MiB margin is intentionally aggressive; increase it if model loading reports CUDA out-of-memory errors. Update the UUIDs if the GPU hardware changes.

The first Open WebUI account becomes the administrator. The Ollama and OpenZIM MCP connections are seeded on the first startup. In a chat, enable **Offline Wikipedia** from the integrations/tools menu so a tool-capable model can use it.

## Models

Pull a model sized for the available VRAM. For example:

```powershell
docker compose exec ollama ollama pull granite4.2:8b
```

Open WebUI discovers installed Ollama models automatically. The host Ollama-compatible API is available at `http://localhost:11434/api`; its OpenAI-compatible subset is at `http://localhost:11434/v1`.

LM Studio models are separate from Ollama models. The validated gateway default is `nemotron-3-nano-4b`, loaded from `nvidia/nemotron-3-nano-4b` at 32,768 context with full GPU offload. `granite-4.2-8b` also runs at 12,288 context but needs 80% GPU offload on the two 4 GB GPUs; full offload runs out of CUDA memory during inference.

The gateway defaults to temperature 0.2, a 2,048-token prediction limit, and at most 24 `.act()` prediction rounds. Clients may override common sampling options and the per-round prediction limit. The optional `options.reasoning_budget` extension reproduces LM Studio GUI reasoning presets through the SDK's raw KV configuration; it is unset by default. Tool arguments and bounded result metadata are logged without article bodies.

## Home Assistant

In Home Assistant, add the **Ollama** integration with:

| Field | Value |
| --- | --- |
| URL | `http://<this-computer-lan-ip>:11435` |
| API key | `HOME_ASSISTANT_GATEWAY_API_KEY` from `.env`; if unset, use `WEBUI_SECRET_KEY` |
| Model | Loaded LM Studio identifier, such as `nemotron-3-nano-4b` |
| Control Home Assistant | Off |

The gateway passes the conversation and three request-scoped tools to LM Studio SDK `.act()`, which owns the reasoning/tool transition and multi-round history. Models see short article handles (`A1`, `A2`) and section handles (`S1`, `S2`) instead of long Kiwix paths and anchors. Handles follow result/document order and do not encode relevance. Section content is returned as native Markdown in block-aware segments; nested tables are converted recursively, tables split only between rows, and split segments repeat their headers.

The compatibility surface includes `/api/chat`, `/api/tags`, `/api/show`, `/api/version`, and `/api/ps`. Bearer authentication and `x-api-key` are supported. Streaming requests currently receive one final NDJSON record after `.act()` finishes rather than incremental tokens.

## Verify and operate

```powershell
Invoke-RestMethod http://localhost:11434/api/tags
Invoke-RestMethod http://localhost:1234/v1/models
Invoke-RestMethod http://localhost:8081/catalog/v2/entries
Invoke-RestMethod http://localhost:8000/readyz
Invoke-RestMethod http://localhost:11435/health
docker compose logs -f
```

Run the reproducible gateway benchmark from the container. It intentionally has no response-header deadline because local multi-round inference can take more than five minutes.

```powershell
docker compose exec -T home-assistant-gateway `
	node dist/benchmark.js nemotron-3-nano-4b --num-predict 2048 --temperature 0.2
```

For the saved Granite condition that limits private reasoning to 64 tokens:

```powershell
docker compose exec -T home-assistant-gateway `
	node dist/benchmark.js granite-4.2-8b --num-predict 2048 --temperature 0.2 --reasoning-budget 64
```

Configuration and secrets are in the ignored `.env` file. `.env.example` documents every setting. OpenZIM MCP persists its writable response cache under the ignored `cache/openzim-mcp` directory. Its response cache holds 500 entries for four hours, with a 64 MiB libzim cluster cache and 2048-entry dirent cache for the large Wikipedia archive. To change the ZIM folder or host ports, edit `.env` and run `docker compose up -d` again.

Set `OPENZIM_MCP_LOG_LEVEL=DEBUG` in `.env` and recreate the OpenZIM container to include function names and debug-level operation details in `docker compose logs openzim-mcp`. Use `INFO` for normal operation because debug logging is verbose and does not provide a built-in stage profiler.

Open WebUI persists admin configuration in its data volume. If its volume already existed before this stack seeded the MCP connection, add it manually under **Settings > Admin > Integrations** with:

| Field | Value |
| --- | --- |
| Type | MCP (Streamable HTTP) |
| URL | `http://openzim-mcp:8000/mcp` |
| Auth | Bearer |
| API key | Value of `OPENZIM_MCP_AUTH_TOKEN` from `.env` |
| ID | `wikipedia` |

To stop the services while retaining models and data, run `docker compose down`. Do not add `--volumes` unless you intend to delete Open WebUI data and downloaded models. The MCP cache is stored in the host `cache/openzim-mcp` directory and is not removed by Docker Compose.