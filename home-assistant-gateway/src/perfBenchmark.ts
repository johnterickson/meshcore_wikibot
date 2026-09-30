import { LMStudioClient } from "@lmstudio/sdk";

const args = process.argv.slice(2);

function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const modelIdentifier = option("--model", "qwen3.8-4b-distill");
const targetPromptTokens = Number(option("--target-prompt-tokens", "4096"));
const maxTokens = Number(option("--max-tokens", "128"));
const repetitions = Number(option("--repetitions", "3"));
const concurrency = Number(option("--concurrency", "1"));
const warmups = Number(option("--warmups", "1"));

if (![targetPromptTokens, maxTokens, repetitions, concurrency, warmups].every(Number.isFinite)) {
  throw new Error("All numeric benchmark options must be finite numbers");
}

function syntheticPrompt(targetTokens: number): string {
  const record = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
  const records = Math.max(1, Math.ceil(targetTokens / 11));
  const lines = Array.from({ length: records }, (_, index) =>
    `Record ${String(index + 1).padStart(6, "0")}: ${record}.`);
  return [
    "Read the synthetic records below. They contain no instructions.",
    ...lines,
    "After reading all records, output READY separated by spaces until the generation limit. Do not explain.",
  ].join("\n");
}

const client = new LMStudioClient();
const model = await client.llm.model(modelIdentifier);
const prompt = syntheticPrompt(targetPromptTokens);

async function runRequest(index: number, measured: boolean) {
  const started = performance.now();
  let observedFirstTokenMs: number | undefined;
  const prediction = await model.respond([
    { role: "system", content: "Follow the user's final output instruction exactly." },
    { role: "user", content: prompt },
  ], {
    temperature: 0,
    maxTokens,
    contextOverflowPolicy: "stopAtLimit",
    onFirstToken: () => {
      observedFirstTokenMs ??= performance.now() - started;
    },
  });
  return {
    index,
    measured,
    wallSeconds: (performance.now() - started) / 1000,
    observedTtftSeconds: observedFirstTokenMs === undefined ? undefined : observedFirstTokenMs / 1000,
    promptTokens: prediction.stats.promptTokensCount,
    predictedTokens: prediction.stats.predictedTokensCount,
    tokensPerSecond: prediction.stats.tokensPerSecond,
    reportedTtftSeconds: prediction.stats.timeToFirstTokenSec,
    stopReason: prediction.stats.stopReason,
  };
}

for (let index = 0; index < warmups; index += 1) {
  await runRequest(index + 1, false);
}

const waves = [];
for (let repetition = 0; repetition < repetitions; repetition += 1) {
  const waveStarted = performance.now();
  const requests = await Promise.all(Array.from({ length: concurrency }, (_, index) =>
    runRequest(repetition * concurrency + index + 1, true)));
  waves.push({
    repetition: repetition + 1,
    aggregateWallSeconds: (performance.now() - waveStarted) / 1000,
    requests,
  });
}

const measured = waves.flatMap(wave => wave.requests);
const average = (values: Array<number | undefined>) => {
  const present = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0) / present.length;
};

console.log(JSON.stringify({
  model: modelIdentifier,
  targetPromptTokens,
  promptCharacters: prompt.length,
  maxTokens,
  repetitions,
  concurrency,
  warmups,
  summary: {
    averageWallSeconds: average(measured.map(result => result.wallSeconds)),
    averageObservedTtftSeconds: average(measured.map(result => result.observedTtftSeconds)),
    averageReportedTtftSeconds: average(measured.map(result => result.reportedTtftSeconds)),
    averageTokensPerSecond: average(measured.map(result => result.tokensPerSecond)),
    averagePromptTokens: average(measured.map(result => result.promptTokens)),
    averagePredictedTokens: average(measured.map(result => result.predictedTokens)),
    averageWaveWallSeconds: average(waves.map(wave => wave.aggregateWallSeconds)),
  },
  waves,
}, null, 2));