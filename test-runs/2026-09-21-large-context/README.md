# Qwen3.8 256K configured-context benchmarks

## Configuration

Both models were loaded with 262,144 configured context, parallel 1, GPU max, and system-RAM spill allowed. The GTX 1650 SUPER remained near its 4 GB VRAM limit; the remaining model and KV allocation used system RAM.

These runs prove that the models can load and execute with a 256K configured context. They do not validate 256K recall: the completed research responses used only 2,350 to 2,744 prompt tokens.

## Results

| Model | Direct HA | Mariners | Spice Girls | Runtime |
| --- | --- | --- | --- | --- |
| Qwen3.8 Distill 4B Q4_K_M | Pass, 5.625 s | Fail, 85.013 s; changed "been to" into "won" | Fail, 591.096 s; wrong names and two wrong dates | Stable and resident |
| Qwen3.8 Distill 9B Q4_K_M | Pass, 13.507 s | **Pass**, 363 s; Seattle Mariners alone | Error, 811.339 s; both researchers exhausted 12 rounds | Stable and resident |

### Token counts

| Model/test | Prompt tokens | Generated tokens |
| --- | ---: | ---: |
| 4B direct HA | 288 | 82 |
| 4B Mariners | 2,576 | 485 |
| 4B Spice Girls | 2,350 | 601 |
| 9B direct HA | 288 | 62 |
| 9B Mariners | 2,744 | 701 |
| 9B Spice Girls | No final response | No final response |

## 9B Spice Girls failure

The benchmark returned HTTP 500 after 811.339 seconds with `List research produced no fetched evidence`. That message is misleading. Attempt 1 retained four successful evidence segments and attempt 2 retained six. Both attempts reached the 12-round child-research limit and ended with literal `<tool_call>` markup rather than a final answer, so each result was classified as malformed and discarded. The fallback failed after the second attempt.

Retrieval itself was healthy. The logs show exact article paths and descriptive section IDs, including `Spice_Girls` / `Group_members`, `Mel_B` / `Early_life`, and `Geri_Halliwell` / `Early_life`.

## Adapter change caveat

The 4B run occurred before the Wiki adapter change and used request-scoped article/section handles. The 9B run used the new contract: search exposes canonical paths only, while sections and fetches use exact paths and descriptive section IDs. The matrix is therefore useful operational evidence, but it is not a controlled model-only comparison.

## Memory

- 4B load increased system RAM from about 19.1 GB to 32.2 GB used, approximately 13.1 GB.
- 9B load increased system RAM from about 21.2 GB to 38.3 GB used, approximately 17.0 GB.
- The 9B Spice run ended around 41.9 GB system RAM used while the model remained healthy and resident.

## Conclusion

Qwen 9B is still the stronger factual candidate because it strictly passed Mariners at both 8K and 256K configured context. Qwen 4B remained faster but failed both research rubrics. A 256K allocation imposes substantial RAM cost without helping these bounded structured prompts, which never approached the configured limit.
