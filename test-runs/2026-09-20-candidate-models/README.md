# Candidate model benchmark matrix

## Scope

These runs compare Qwen3.8 Distill 2B, 4B, and 9B, LFM2.5 2.6B, and Ornith 1.5 9B. The 4B, 9B, and Ornith corrected reruns used 8,192 context, parallel 1, the GTX 1650 SUPER with the Quadro K1200 excluded from LM Studio, and system-RAM spill allowed.

The earlier 2B and LFM runs used 32,768 context and a GTX-priority full-offload plan. They were not repeated under the corrected 8K configuration.

## Results

| Model | Configuration | Direct HA | Private HA gateway | Mariners wiki | Residency |
| --- | --- | --- | --- | --- | --- |
| Qwen3.8 Distill 2B Q6_K | 32K baseline | Pass, 1.819 s | Pass in captured control run | Fail, 12.986 s; hallucinated many teams | Stable |
| LFM2.5 2.6B Q6_K | 32K baseline | Pass, 1.808 s | Pass in captured control run | Error, 367.394 s; structured list extraction failed | Stable |
| Qwen3.8 Distill 4B Q4_K_M | Corrected 8K | Pass, 22.126 s | Pass, 2.149 s | Fail, 99.876 s; returned nine incorrect teams | Stable and resident |
| Qwen3.8 Distill 9B Q4_K_M | Corrected 8K | Pass, 10.432 s | Pass, 6.281 s | **Pass**, 163.247 s; returned Seattle Mariners alone | Stable and resident |
| Ornith 1.5 9B Q4_K_M | Corrected 8K | Pass, 10.027 s | Pass, 5.318 s | Fail, 214.548 s; exhausted output before a definitive answer | Stable and resident |

The Qwen 9B runtime artifact contains a stale `STRICT_SEMANTIC_GRADE=FAIL` line, but its logged answer explicitly says there is only one qualifying team and names the Seattle Mariners. Under the stated rubric, that run is a strict pass.

The Ornith control artifact's `loaded=false` field came from an identifier-matching bug. `lms ps` before and after the direct request, and after the wiki request, shows `ornith-1.5-9b` remained resident.

## Qwen 4B structured 8K test

A separate Spice Girls test evaluated whether the bounded list-map-reduce path could compensate for Qwen 4B's failed free-form 8K trace.

| Measure | Result |
| --- | --- |
| Request | 6; the earlier request 5 was an unintended wrapper submission and is excluded |
| Wall time | 383.688 s |
| Orchestration | `research_question -> research_list -> research_map -> research_reduce` |
| List/map coverage | 5 discovered, 5 mapped, 5 reduced |
| Stage names | Pass |
| Five dates | Pass |
| `YYYY/MM/DD` format | Pass |
| Exact birth names | Fail |
| Overall strict grade | **Fail** |

The map records contained the full birth names, but the final reducer changed them to familiar public names such as `Victoria Beckham`, `Mel B`, and `Geri Halliwell`. This is a final-synthesis fidelity failure, not an entity-retention failure. Structuring the task therefore fixed the free-form 8K looping and omission problem, but deterministic validation or stricter reduction is still required for exact-name output.

## Configuration interpretation

Earlier Qwen and Ornith unloads or failures under larger contexts, mixed K1200 offload, or disallowed RAM spill do not describe the corrected deployment. Qwen 4B, Qwen 9B, and Ornith all completed the corrected 8K runs while remaining resident. Semantic failures must be kept separate from runtime stability.

## Recommendation

Qwen3.8 Distill 9B is the strongest candidate in this matrix: it passed both HA tool calling and the strict Mariners task. Qwen 4B is viable for HA and can complete multi-entity research at 8K through structured map-reduce, but its reducer does not reliably preserve exact field values. Ornith is stable and handles HA tools, but did not complete the wiki answer within the output budget.

The normal service model remains `nvidia/nemotron-3-nano-4b` at 32,768 context; this matrix does not change that production default.
