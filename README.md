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

The gateway passes the conversation and three request-scoped tools to LM Studio SDK `.act()`, which owns the reasoning/tool transition and multi-round history. Models see short article handles (`A1`, `A2`) and section handles (`S1`, `S2`) instead of long Kiwix paths and anchors. Handles follow result/document order and do not encode relevance. Section content is returned as native Markdown in block-aware segments; nested tables are converted recursively, tables split only between rows, and split segments repeat their headers.

The compatibility surface includes `/api/chat`, `/api/tags`, `/api/show`, `/api/version`, and `/api/ps`. Bearer authentication and `x-api-key` are supported. Streaming requests currently receive one final NDJSON record after `.act()` finishes rather than incremental tokens.

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
	node dist/benchmark.js nvidia/nemotron-3-nano-4b --num-predict 2048 --temperature 0.2
```

For the saved Granite condition that limits private reasoning to 64 tokens:

```powershell
docker compose exec -T home-assistant-gateway `
	node dist/benchmark.js granite-4.2-8b --num-predict 2048 --temperature 0.2 --reasoning-budget 64
```

Configuration and secrets are in the ignored `.env` file. `.env.example` documents every setting. OpenZIM MCP persists its writable response cache under the ignored `cache/openzim-mcp` directory. Its response cache holds 500 entries for four hours, with a 64 MiB libzim cluster cache and 2048-entry dirent cache for the large Wikipedia archive. To change the ZIM folder or host ports, edit `.env` and run `docker compose up -d` again.

Set `OPENZIM_MCP_LOG_LEVEL=DEBUG` in `.env` and recreate the OpenZIM container to include function names and debug-level operation details in `docker compose logs openzim-mcp`. Use `INFO` for normal operation because debug logging is verbose and does not provide a built-in stage profiler.

To stop the Docker services, run `docker compose down`. LM Studio models are managed outside Docker. The MCP cache is stored in the host `cache/openzim-mcp` directory and is not removed by Docker Compose.