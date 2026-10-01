# Offline Wikipedia AI stack

This project runs a fully local Wikipedia research and Home Assistant stack:

- Kiwix Serve reads every `.zim` archive under `ZIM_PATH`.
- LocalWiki MCP exposes `wiki_search`, `wiki_sections`, and `wiki_fetch` over internal authenticated HTTP.
- The public Ollama-compatible gateway uses LM Studio `.act()` to orchestrate grounded Wikipedia research.
- The private Ollama-compatible gateway translates Home Assistant tools to LM Studio's OpenAI-compatible API and verifies state-changing actions.

OpenZIM MCP is no longer part of the active Compose graph. Its commented block remains in `compose.yaml` only as historical configuration. LocalWiki MCP is the sole Wikipedia tool service.

## Architecture

```text
Home Assistant / API client
	   |
	   +-- :11435 wiki gateway -- LM Studio SDK .act()
	   |                              |
	   |                        research tools
	   |                              |
	   |                    LocalWiki MCP (internal)
	   |                              |
	   |                            Kiwix
	   |
	   +-- :11436 control gateway -- LM Studio OpenAI API
						   |
					   Home Assistant tools
```

The two gateway listeners share one abort-aware FIFO mutex. Wiki research and device control therefore never run the 4 GB model concurrently.

## Start

Docker Desktop must use the WSL 2 backend. Verify GPU access:

```powershell
docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi
```

Copy `.env.example` to the ignored `.env`, set independent random gateway keys, set the LocalWiki bearer token, and point `ZIM_PATH` at the archive directory. The environment variable is still named `OPENZIM_MCP_AUTH_TOKEN` for compatibility, but it now protects LocalWiki MCP.

Start LM Studio's local server on port 1234, enable network access, and load the identifier selected by `HOME_ASSISTANT_MODEL`. The current default and deployed model is `nvidia/nemotron-3-nano-4b` at 32,768 context and parallel 1:

```powershell
lms load nvidia/nemotron-3-nano-4b --context-length 32768 --parallel 1 --gpu max --identifier nvidia/nemotron-3-nano-4b --ttl 3600 -y
docker compose pull
docker compose up -d --build
docker compose ps
```

Active endpoints:

| Service | URL | Exposure |
| --- | --- | --- |
| Kiwix | `http://localhost:8081` | Host loopback only |
| LM Studio API | `http://localhost:1234` | Host process |
| Public wiki gateway | `http://localhost:11435` | LAN, API key required under `/api` |
| Private HA control gateway | `http://localhost:11436` | LAN, separate API key required |

LocalWiki MCP is intentionally not published to a host port. The gateway reaches it at `http://localwiki-mcp:8080/mcp` on the Compose network.

The gateways listen on all host interfaces. Use `http://<lan-ip>:11435` and `http://<lan-ip>:11436` from Home Assistant. LM Studio must accept connections from `host.docker.internal`. Never expose LM Studio or the private control gateway to untrusted networks.

## Models

`nvidia/nemotron-3-nano-4b` remains the conservative shared default and passes the representative Wikipedia and Home Assistant tool-call cases. `spark-x2.5-4b` is also qualified: it passed the Mariners and Spice Girls research discriminators plus private HA tool calling, and it handled the current LocalWiki tool contract directly. Select it by setting `HOME_ASSISTANT_MODEL=spark-x2.5-4b` and loading that identifier in LM Studio.

Qwen3.8 Distill 4B Q4_K_M is fastest at 8,192 context, parallel 1, with GPU KV enabled, but it is not the shared default because it failed the Mariners predicate. `granite-4.2-8b` runs at 12,288 context but requires partial GPU offload. Detailed results and saved artifacts are in `MODEL_EXPERIMENTS.md`, `manual_runs/`, and `test-runs/`.

The gateway defaults to temperature 0.2, a 2,048-token prediction limit, and at most 24 SDK prediction rounds. Common sampling options can be overridden per request. The optional `options.reasoning_budget` extension maps to LM Studio's raw reasoning configuration and is unset by default. Tool arguments and bounded metadata are logged; article bodies are not.

## Home Assistant

Add two **Ollama** integration instances in Home Assistant:

| Setting | Public Wikipedia agent | Private control agent |
| --- | --- | --- |
| Name | Offline Wikipedia | Private Home Control |
| URL | `http://<this-computer-lan-ip>:11435` | `http://<this-computer-lan-ip>:11436` |
| API key | `HOME_ASSISTANT_GATEWAY_API_KEY` | `HOME_ASSISTANT_CONTROL_GATEWAY_API_KEY` |
| Model | Loaded LM Studio identifier | Same loaded LM Studio identifier |
| Control Home Assistant | Off | On |

Route the public room only to Offline Wikipedia and the private room only to Private Home Control. Enforce that allowlist in Home Assistant or the chat bridge because LM Studio does not receive trustworthy room identity. Use independent random API keys, firewall port 11436 to Home Assistant, and expose only carefully selected entities to the private agent.

The public endpoint rejects client-supplied tools. The private endpoint receives Home Assistant tools but never receives the wiki prompt or tools. `HOME_ASSISTANT_CONTROL_GATEWAY_API_KEY` falls back to the public key for compatibility; use a distinct key in production. Home Assistant's `num_ctx`, `keep_alive`, and `think` values are not forwarded because model context, residency, and reasoning are controlled in LM Studio.

The control gateway enforces exact action semantics: open, close, stop, pause, toggle, on, and off are never substituted for one another. A tool request alone is not treated as success. The gateway reads Home Assistant's `data.success` and `data.failed`, requires `HassGetState` verification after state changes, and rechecks moving covers up to three observations. Its final success or unconfirmed-state message is generated deterministically from observed state rather than model confidence.

The example MeshCore automation in `scripts/ha.automation.yml` consumes signed raw contact events. Shared-room messages expose the room server as the transport sender, while `txt_type: 2` includes the first eight hex characters of the participant's public key in `signature`. The automation keys each conversation by room public key plus participant signature, routes the private room public key to HA control, and replies through the room server. Known signatures map to contact names for a visible `@name` prefix; unknown participants fall back to `@<signature>`. Exact `help` and `/help` requests bypass the `[thinking]` message. Replies remain within 100 characters and are paced ten seconds apart, beyond the observed MeshCore ACK timeout, for reliable radio delivery.

## Research

The parent planner receives four request-scoped tools:

- `research_question` runs one clean researcher for a simple or aggregate question.
- `research_list` discovers and stores canonical set members behind a dataset handle.
- `research_map` applies one field-preserving question to every stored member.
- `research_reduce` reviews, repairs, and reduces the complete map.

Research has two explicit modes:

- `/query` is the default for a single subject or an aggregate set-filter question.
- `/map` runs membership-only discovery followed by per-item mapping and reduction.
- `/new` discards earlier conversation history and composes with either mode.
- `help` or `/help` returns the local command summary without invoking the model.

Examples:

```text
/new /query Was George H. W. Bush left-handed?
/new /query Which active MLB teams have never appeared in the World Series?
/new /map Who are the Spice Girls and what are their birthdays?
```

Set-filter enumeration is a fallback. The planner must first attempt one authoritative aggregate source; it may enumerate entities only after that attempt is partial or failed. Attribute-oriented mapping uses membership-only discovery so aliases and requested fields cannot become accidental list members.

Each child researcher receives LocalWiki's MCP tool names, descriptions, and JSON schemas dynamically. The gateway no longer redefines `wiki_fetch` parameters, so `section_id`, `section_page`, and the returned `next` pointer pass through unchanged. LocalWiki returns focused errors for missing paths, invalid sections, and out-of-range pages.

Fetched Markdown is block-aware, preserves internal article links, keeps table rows intact, and repeats headers when tables span pages. Only successful `wiki_fetch` content counts as evidence. Empty or malformed child answers are synthesized again from collected evidence. Transient LM Studio failures reacquire the model and retry the child once. Final parent inference also retries once; if synthesis still fails, the gateway returns the latest grounded child answer instead of losing completed research. Raw SDK failures are logged internally and replaced with a stable public message.

For `/map`, reduction assesses every requested field on every record. Omitted or unsatisfied assessments become deterministic repairs. The repair budget scales with record-field cells from 8 to 24 calls; review output is capped between 1,536 and 4,096 tokens. Researchers and repairs remain serial because the model runs at parallel 1.

The public compatibility surface includes `/api/chat`, `/api/tags`, `/api/show`, `/api/version`, and `/api/ps`. Bearer authentication and `x-api-key` are supported. Streaming requests receive Ollama-compatible NDJSON progress in `message.thinking`, followed by one final `done:true` record. Non-streaming requests receive one JSON response.

## Verify and operate

```powershell
Invoke-RestMethod http://localhost:1234/v1/models
Invoke-RestMethod http://localhost:8081/catalog/v2/entries
Invoke-RestMethod http://localhost:11435/health
Invoke-RestMethod http://localhost:11436/health
docker compose logs -f home-assistant-gateway localwiki-mcp
```

Run the reproducible gateway benchmark from the container. It intentionally has no response-header deadline because local multi-round inference can take more than five minutes.

```powershell
docker compose exec -T home-assistant-gateway `
	node dist/benchmark.js nvidia/nemotron-3-nano-4b --question "<question>" --num-predict 2048 --temperature 0.2
```

Benchmark JSON escapes non-ASCII characters so PowerShell redirection and `Tee-Object` preserve output without code-page corruption. JSON parsers decode those escapes back to the original text.

To benchmark Spark instead, load it in LM Studio and replace the model identifier with `spark-x2.5-4b`. For models that support a constrained private reasoning budget:

```powershell
docker compose exec -T home-assistant-gateway `
	node dist/benchmark.js <model> --question "<question>" --num-predict 2048 --temperature 0.2 --reasoning-budget 64
```

Run the test suites before rebuilding:

```powershell
Set-Location home-assistant-gateway
npm test
Set-Location ..\localwiki-mcp
npm test
Set-Location ..
docker compose config --quiet
```

Configuration and secrets live in the ignored `.env`. To change the ZIM folder, model identifier, or host ports, edit `.env` and run `docker compose up -d --build` again.

To stop the Docker services, run `docker compose down`. LM Studio models are managed outside Docker.