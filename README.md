# Offline Wikipedia AI stack

This Docker Compose project runs:

- Kiwix Serve for every `.zim` archive under `F:\wikipedia`
- OpenZIM MCP with streamable HTTP and bearer authentication
- Ollama with access to the host NVIDIA GPU
- Open WebUI connected to Ollama and pre-seeded with the OpenZIM MCP server
- An Ollama-compatible Home Assistant gateway that connects Qwen directly to OpenZIM MCP

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

Ollama is restricted to the GTX 1650 SUPER identified by `OLLAMA_GPU_DEVICE_ID` in `.env`; the K1200 remains unavailable to inference. Flash attention, a quantized KV cache, single-request concurrency, zero configured GPU overhead, and `LLAMA_ARG_FIT_TARGET=128` maximize the model layers that fit in GTX VRAM. `OLLAMA_CONTEXT_LENGTH=8192` keeps the default context fully GPU-resident; requests may still override it with `options.num_ctx`. The 128 MiB margin is intentionally aggressive because the GTX is dedicated to compute; increase it if model loading reports CUDA out-of-memory errors. Update the UUID if the GPU hardware changes.

The first Open WebUI account becomes the administrator. The Ollama and OpenZIM MCP connections are seeded on the first startup. In a chat, enable **Offline Wikipedia** from the integrations/tools menu so a tool-capable model can use it.

## Models

Pull a model sized for the available VRAM. For example:

```powershell
docker compose exec ollama ollama pull qwen3:4b
```

Open WebUI discovers installed Ollama models automatically. The host Ollama-compatible API is available at `http://localhost:11434/api`; its OpenAI-compatible subset is at `http://localhost:11434/v1`.

The text-only `qwen3:4b` is preferred for the Home Assistant gateway. On this GTX it offloads 37/37 layers and reports 100% GPU at the configured 8192-token context; testing found that 9216 also remains fully GPU-resident, while 9472 spills one layer to CPU. The multimodal `qwen3.5:4b` also loads but reserves VRAM for its vision projector.

## Home Assistant

In Home Assistant, add the **Ollama** integration with:

| Field | Value |
| --- | --- |
| URL | `http://<this-computer-lan-ip>:11435` |
| API key | `HOME_ASSISTANT_GATEWAY_API_KEY` from `.env`; if unset, use `WEBUI_SECRET_KEY` |
| Model | `qwen3:4b` |
| Control Home Assistant | Off |

The gateway sends `/api/chat` directly to Ollama, exposes OpenZIM's `zim_query` tool to Qwen, executes its MCP calls, and returns an Ollama-compatible response. Other Ollama API calls are authenticated and proxied to the local Ollama service. Open WebUI remains available for browser chats but is not part of the Home Assistant request path. Keep **Control Home Assistant** off because this conversation agent reserves tool use for Offline Wikipedia.

## Verify and operate

```powershell
Invoke-RestMethod http://localhost:11434/api/tags
Invoke-RestMethod http://localhost:8081/catalog/v2/entries
Invoke-RestMethod http://localhost:8000/readyz
docker compose logs -f
```

Configuration and secrets are in the ignored `.env` file. `.env.example` documents every setting. To change the ZIM folder or host ports, edit `.env` and run `docker compose up -d` again.

Open WebUI persists admin configuration in its data volume. If its volume already existed before this stack seeded the MCP connection, add it manually under **Settings > Admin > Integrations** with:

| Field | Value |
| --- | --- |
| Type | MCP (Streamable HTTP) |
| URL | `http://openzim-mcp:8000/mcp` |
| Auth | Bearer |
| API key | Value of `OPENZIM_MCP_AUTH_TOKEN` from `.env` |
| ID | `wikipedia` |

To stop the services while retaining models and data, run `docker compose down`. Do not add `--volumes` unless you intend to delete Open WebUI data, downloaded models, and the MCP cache.