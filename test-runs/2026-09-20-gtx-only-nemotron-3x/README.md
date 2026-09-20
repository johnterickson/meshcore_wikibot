# GTX-only Nemotron 3x consistency matrix

## Configuration

- Model: `nvidia/nemotron-3-nano-4b`
- Runtime: LM Studio CUDA llama.cpp 2.41.0
- Device: GTX 1650 SUPER only; Quadro K1200 excluded
- Context: 32,768 tokens
- Maximum output: 2,048 tokens
- Temperature: 0.2
- Concurrency: one complete gateway request at a time

Each trial has a benchmark response, UTC timing window, and timestamped gateway log in this directory.

## Strict grading

- Spice Girls passes only if all five members and all five `YYYY/MM/DD` birthdays are present and correct.
- World Series passes only if the answer contains the Seattle Mariners and no other team.
- Transport passes when the benchmark receives HTTP 200, exits with code 0, and the gateway emits `chat_released`.

| Trial | Wall time | Transport | Semantic | Result |
|---|---:|---|---|---|
| Spice Girls 1 | 531.235 s | Pass | Fail | Four birthdays; Melanie Brown remained `unknown` after one targeted repair. |
| Spice Girls 2 | 89.669 s | Pass | Fail | All five birthdays were `unknown`. |
| Spice Girls 3 | 163.238 s | Pass | Fail | Fabricated 1994 as the birth year for all five members. |
| World Series 1 | 41.324 s | Pass | Fail | Incorrectly added the Dodgers and Blue Jays. |
| World Series 2 | 94.597 s | Pass | Fail | Changed "been to" into "won" and returned 17 incorrect teams. |
| World Series 3 | 92.825 s | Pass | Pass | Returned only the Seattle Mariners. |

Semantic score: **1/6 overall**; Spice Girls **0/3**; World Series **1/3**.

Transport score: **6/6**. All trials returned HTTP 200, exited normally, and released the FIFO mutex.

## Orchestration findings

- Spice Girls trial 1 completed list, map, complete-cell review, one targeted repair, and reduce. Trials 2 and 3 took a single aggregate-research shortcut and never entered the list/map/review pipeline.
- All three World Series trials began with aggregate research as required.
- In World Series trial 2, the model tried to enumerate teams after aggregate research. The deterministic boundary blocked both `research_list` calls, confirming that model-controlled `purpose` can no longer bypass the aggregate-first policy.
- Review-coverage hardening worked in the full Spice Girls pipeline: all 15 required cells were assessed before repair planning.
- The safeguards now enforce route and review invariants, but they cannot make weak or misread source evidence factually correct.

## Recommendation

Keep this GTX-only 4B deployment as the practical responsive configuration for development and low-stakes use, with FIFO concurrency and the new deterministic safeguards enabled. Do not use its answers unattended for factual research: the observed strict accuracy is too low and materially inconsistent.

For higher factual reliability, use a stronger model on hardware with substantially more VRAM or a remote inference host. A 27B model is not a practical resident GPU workload on the GTX 1650 SUPER's 4 GB VRAM; heavy CPU offload would sacrifice the latency advantage of this setup. Independently of model size, add deterministic output validation for answer-level constraints and fail closed when required facts remain unresolved.