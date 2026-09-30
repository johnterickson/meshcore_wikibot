# Qwen3.8 4B Performance Matrix

Date: 2026-09-21

## Scope

This matrix measures `qwen3.8-4b-distill` Q4_K_M through the LM Studio SDK. It is a performance study, not a quality qualification. Every cell explicitly unloaded all models, verified an empty LM Studio state, loaded the requested configuration, and restored `nvidia/nemotron-3-nano-4b` afterward.

The fixed short workload contained 6,061 actual prompt tokens and generated 128 tokens. The SDK GPU order was verified independently: GPU 0 is the GTX 1650 SUPER and GPU 1 is the Quadro K1200. Corrected KV cells used 3,861 MiB on the GTX and 387 MiB on the Quadro.

## Configured Context

| Context | Wall time | Observed TTFT | Generation |
| ---: | ---: | ---: | ---: |
| 8,192 | 2.759 s | 0.120 s | 48.22 tok/s |
| 32,768 | 4.320 s | 0.154 s | 30.52 tok/s |
| 131,072 | 5.010 s | 0.178 s | 26.31 tok/s |
| 262,144 | 5.049 s | 0.173 s | 26.06 tok/s |

Configured context is not free on this hardware. For this prompt, 32K reduced generation throughput by 36.7% relative to 8K. Contexts above 32K provided no useful short-request performance benefit.

## Parallel Requests

Four simultaneous 6,061-token requests were issued against a 32K model load.

| LM Studio parallel setting | Average request wall | Wave wall | Average generation |
| ---: | ---: | ---: | ---: |
| 1 | 10.54 s | 16.92 s | 31.25 tok/s |
| 4 | 131.08 s | 132.27 s | 5.31 tok/s |

Parallel 4 is unsuitable for this 4 GB GPU. The gateways already serialize top-level workloads with one FIFO mutex, so parallel 1 matches the production workload.

## Actual Long Prompts

| Actual prompt tokens | TTFT | Wall time | Generation |
| ---: | ---: | ---: | ---: |
| 32,835 | 471.6 s | 481.6 s | 12.79 tok/s |
| 131,131 | 3,505.3 s | 3,532.4 s | 4.69 tok/s |

Large configured windows are loadable, but large consumed contexts are operationally expensive. A 131K-token prompt required about 58 minutes before the first token.

## KV Cache Placement

The corrected KV comparison used the GTX 1650 SUPER, 32K configured context, a 6,061-token prompt, one warmup, and three measured repetitions.

| KV cache | Wall time | Observed TTFT | Generation |
| --- | ---: | ---: | ---: |
| GPU | 6.254 s | 0.221 s | 21.06 tok/s |
| RAM | 6.279 s | 0.226 s | 21.00 tok/s |

The difference is within run-to-run noise. Keep GPU KV enabled because it is not slower and is the normal accelerated path.

## Recommendation

For Qwen3.8 4B, use 8,192 context, parallel 1, GPU KV enabled, FP16 KV, and temperature 0.2. Use 32,768 context only for requests that demonstrably need more than 8K; do not use 128K or 256K as the default.

Do not promote Qwen3.8 4B to the shared Home Assistant/Wikipedia default based on this matrix. It passed Home Assistant tool calling but failed the Mariners appearance predicate in quality testing. Keep `nvidia/nemotron-3-nano-4b` as the shared default; Qwen3.8 9B passed the quality cases but its 8K Spice Girls run took about 35 minutes, making it a slower quality-focused alternative rather than the operational default.

After the matrix, Nemotron was restored at 8,192 context and parallel 4. LM Studio and both gateway health endpoints returned HTTP 200.