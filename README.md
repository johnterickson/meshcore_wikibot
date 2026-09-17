# Offline Wikipedia AI stack

This Docker Compose project runs:

- Kiwix Serve for every `.zim` archive under `D:\wikipedia`
- OpenZIM MCP with streamable HTTP and bearer authentication
- Ollama with access to the host NVIDIA GPU
- Open WebUI connected to Ollama and pre-seeded with the OpenZIM MCP server
- An Ollama-compatible Home Assistant gateway that connects Bonsai directly to OpenZIM MCP

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

Ollama uses both the Quadro K1200 and GTX 1650 SUPER identified by `OLLAMA_GPU_DEVICE_IDS` in `.env`. Flash attention, a quantized KV cache, single-request concurrency, zero configured GPU overhead, and `LLAMA_ARG_FIT_TARGET=128` maximize the model layers that fit in combined VRAM. `OLLAMA_CONTEXT_LENGTH=8192` keeps Bonsai 27B fully GPU-resident; requests may still override it with `options.num_ctx`. The 128 MiB margin is intentionally aggressive; increase it if model loading reports CUDA out-of-memory errors. Update the UUIDs if the GPU hardware changes.

The first Open WebUI account becomes the administrator. The Ollama and OpenZIM MCP connections are seeded on the first startup. In a chat, enable **Offline Wikipedia** from the integrations/tools menu so a tool-capable model can use it.

## Models

Pull a model sized for the available VRAM. For example:

```powershell
docker compose exec ollama ollama pull wcamaralopes/bonsai-27b:latest
```

Open WebUI discovers installed Ollama models automatically. The host Ollama-compatible API is available at `http://localhost:11434/api`; its OpenAI-compatible subset is at `http://localhost:11434/v1`.

The text-only `wcamaralopes/bonsai-27b:latest` model is configured for the Home Assistant gateway. At the 8192-token context it is fully GPU-offloaded across both GPUs. The gateway uses temperature zero and allows 1024 output tokens per prediction. Its compact Wikipedia profile assumes one configured ZIM, exposes only `wiki_search` and `wiki_fetch`, and permits at most four five-result searches and two 4000-character article fetches before the model must answer. Tool arguments and bounded result metadata are logged without article bodies.

## Home Assistant

In Home Assistant, add the **Ollama** integration with:

| Field | Value |
| --- | --- |
| URL | `http://<this-computer-lan-ip>:11435` |
| API key | `HOME_ASSISTANT_GATEWAY_API_KEY` from `.env`; if unset, use `WEBUI_SECRET_KEY` |
| Model | `wcamaralopes/bonsai-27b:latest` |
| Control Home Assistant | Off |

The gateway sends `/api/chat` directly to Ollama, exposes the compact `wiki_search` and `wiki_fetch` LocalWiki MCP tools to Bonsai, executes up to 24 MCP tool rounds, and returns an Ollama-compatible response. Other Ollama API calls are authenticated and proxied to the local Ollama service. Open WebUI remains available for browser chats but is not part of the Home Assistant request path. Keep **Control Home Assistant** off because this conversation agent reserves tool use for Offline Wikipedia.

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