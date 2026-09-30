import { LMStudioClient } from "@lmstudio/sdk";

const args = process.argv.slice(2);

function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const modelKey = option("--model", "qwen3.8-4b-distill");
const identifier = option("--identifier", modelKey);
const contextLength = Number(option("--context-length", "32768"));
const offloadKVCacheToGpu = option("--kv-gpu", "true").toLowerCase() === "true";
const evalBatchSize = Number(option("--eval-batch-size", "512"));
const flashAttention = option("--flash-attention", "false").toLowerCase() === "true";
const useFp16ForKVCache = option("--fp16-kv", "true").toLowerCase() === "true";

const client = new LMStudioClient();
const started = performance.now();
const gpu = { ratio: "max" as const, mainGpu: 0, disabledGpus: [1] };
await client.llm.load(modelKey, {
  identifier,
  ttl: 3600,
  config: {
    gpu,
    contextLength,
    offloadKVCacheToGpu,
    evalBatchSize,
    flashAttention,
    useFp16ForKVCache,
  },
});

console.log(JSON.stringify({
  modelKey,
  identifier,
  contextLength,
  gpu,
  offloadKVCacheToGpu,
  evalBatchSize,
  flashAttention,
  useFp16ForKVCache,
  loadWallSeconds: (performance.now() - started) / 1000,
}, null, 2));