# Offline Wikipedia AI stack

This Docker Compose project runs:

- Kiwix Serve for every `.zim` archive under `D:\wikipedia`
- OpenZIM MCP with streamable HTTP and bearer authentication
- Ollama with access to the host NVIDIA GPU
- Open WebUI connected to Ollama and pre-seeded with the OpenZIM MCP server
- An Ollama-compatible Home Assistant gateway that connects Granite directly to LocalWiki MCP

## Start

Docker Desktop must use the WSL 2 backend, and `docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi` must be able to see the GPU.

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
| OpenZIM MCP | http://localhost:8000/mcp |
| OpenZIM MCP readiness | http://localhost:8000/readyz |
| Home Assistant gateway | http://localhost:11435 |

Ollama and the Home Assistant gateway listen on all host interfaces. From another device on the LAN, use `http://<this-computer-lan-ip>:11434` for raw Ollama or `http://<this-computer-lan-ip>:11435` for the authenticated Wiki-enabled gateway.

Ollama uses both the Quadro K1200 and GTX 1650 SUPER identified by `OLLAMA_GPU_DEVICE_IDS` in `.env`. Flash attention, a quantized KV cache, single-request concurrency, zero configured GPU overhead, and `LLAMA_ARG_FIT_TARGET=128` maximize the model layers that fit in combined VRAM. `OLLAMA_CONTEXT_LENGTH=12288` keeps Granite at the validated context; requests may still override it with `options.num_ctx`. `OLLAMA_KEEP_ALIVE=-1` keeps the active model loaded between tool rounds and requests. The 128 MiB margin is intentionally aggressive; increase it if model loading reports CUDA out-of-memory errors. Update the UUIDs if the GPU hardware changes.

The first Open WebUI account becomes the administrator. The Ollama and OpenZIM MCP connections are seeded on the first startup. In a chat, enable **Offline Wikipedia** from the integrations/tools menu so a tool-capable model can use it.

## Models

Pull a model sized for the available VRAM. For example:

```powershell
docker compose exec ollama ollama pull granite4.2:8b
```

Open WebUI discovers installed Ollama models automatically. The host Ollama-compatible API is available at `http://localhost:11434/api`; its OpenAI-compatible subset is at `http://localhost:11434/v1`.

The text-only `granite4.2:8b` model is configured for the Home Assistant gateway. At the validated 12,288-token context it is fully GPU-offloaded across both GPUs. The gateway defaults to temperature 0.2, sets `repeat_last_n=64`, uses Ollama's low-effort thinking mode, and exposes `wiki_search`, `wiki_sections`, and `wiki_fetch`. Clients may override generation options. Each search returns up to 25 results. Search and fetch calls have no separate caps; a 24-round circuit breaker terminates pathological loops. Tool arguments and bounded result metadata are logged without article bodies.

Ollama's `low` thinking level is a qualitative reasoning-effort control, not an exact token budget. LM Studio's successful Granite test used a separate 64-token reasoning budget; Ollama does not expose an equivalent numeric control for this model.

## Home Assistant

In Home Assistant, add the **Ollama** integration with:

| Field | Value |
| --- | --- |
| URL | `http://<this-computer-lan-ip>:11435` |
| API key | `HOME_ASSISTANT_GATEWAY_API_KEY` from `.env`; if unset, use `WEBUI_SECRET_KEY` |
| Model | `granite4.2:8b` |
| Control Home Assistant | Off |

The gateway sends `/api/chat` directly to Ollama and uses an intentional `wiki_search` -> `wiki_sections` -> `wiki_fetch` flow. Granite sees request-scoped article handles (`A1`, `A2`) and section handles (`S1`, `S2`) instead of long Kiwix paths and anchors. Handles follow result/document order and do not encode relevance. Section content is returned as native Markdown in block-aware segments; tables split only between rows and repeat their headers. Previous reasoning traces are removed from model history while the current response still exposes its reasoning for diagnostics. Compaction runs only when Ollama's measured prompt usage plus newly appended tool messages is estimated to reach 85% of the request's context window. It summarizes only accumulated retrieval work without tools or hidden thinking. The original gateway policy and client messages are excluded from that request, then restored unchanged after the mechanical handle registry and advisory summary. Failed compaction leaves the existing history intact. A 24-round circuit breaker remains in place.

## Verify and operate

```powershell
Invoke-RestMethod http://localhost:11434/api/tags
Invoke-RestMethod http://localhost:8081/catalog/v2/entries
Invoke-RestMethod http://localhost:8000/readyz
docker compose logs -f
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