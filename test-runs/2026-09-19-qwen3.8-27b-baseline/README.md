 baseline


## Configuration

- Model: `qwen/qwen3.8-27b` (`Q4_K_M`, 27B)
- Loaded context length: 32,768
- Temperature: 0.2
- Prediction limit: 2,048 tokens
- Gateway image: same image as the active `home-assistant-gateway` service
- Retrieval: existing LocalWiki MCP and offline Wikipedia services

## Results

| Case | HTTP | Wall time | Hierarchy | Semantic result |
| --- | ---: | ---: | --- | --- |
| Spice Girls | 500 | 240.178 s | Correct `research_list` -> five-item `research_map`; first three records completed | Incomplete because the remote LM Studio engine unloaded/crashed during the fourth mapped record |
| Mariners | 200 | 128.768 s | Correct aggregate-first `research_question`; no unnecessary list/map fan-out | Pass: Seattle Mariners only |

## Spice Girls trace

Qwen selected `research_list` in round 1 and discovered exactly five unique subjects:

- Scary Spice
- Baby Spice
- Sporty Spice
- Posh Spice
- Ginger Spice

It then selected `research_map` in round 2 with precise `stage_name`, `real_name`, and `birthday` requirements. The first three records were grounded correctly:

- Scary Spice: Melanie Janine Brown, 1975/05/29
- Baby Spice: Emma Lee Bunton, date returned as `1976-01-21` rather than the requested slash format
- Sporty Spice: Melanie Jayne Chisholm, 1974/01/12

At Posh Spice, LM Studio returned `Engine protocol predict request failed: fetch failed`; both retries for Posh and Ginger failed immediately. The gateway isolated those failures and completed the map structurally, but the top-level prediction then failed with the same engine error. The model's loaded instance was absent afterward. Direct host and container completions subsequently succeeded by auto-loading the model again.

This is an infrastructure failure after successful hierarchy selection, not evidence that Qwen rejected the hierarchy.

## Mariners trace

Qwen selected `research_question` with the complete original aggregate question. The clean subagent searched offline Wikipedia, fetched the World Series record table and notes, and returned Seattle Mariners as the sole active team with no World Series appearance. The top-level model answered correctly in two rounds without list/map fallback.

## Artifacts

- `spice-girls-benchmark.txt`
- `spice-girls-window.txt`
- `spice-girls-gateway.log`
- `mariners-benchmark.txt`
- `mariners-window.txt`
- `mariners-gateway.log`
