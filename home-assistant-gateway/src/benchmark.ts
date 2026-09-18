import { request } from "node:http";

const args = process.argv.slice(2);
const model = args.shift();
if (!model) {
  console.error("Usage: node dist/benchmark.js <model> [--question text] [--num-predict n] [--temperature n] [--reasoning-budget n]");
  process.exit(2);
}

function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const question = option("--question", "Which active MLB teams have never been to the World Series?");
const numPredict = Number(option("--num-predict", "2048"));
const temperature = Number(option("--temperature", "0.2"));
const reasoningBudgetValue = option("--reasoning-budget", "");
const reasoningBudget = reasoningBudgetValue === "" ? undefined : Number(reasoningBudgetValue);
const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:8080";
const apiKey = process.env.GATEWAY_API_KEY;
if (!apiKey) throw new Error("GATEWAY_API_KEY is required");

function postJson(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const requestHandle = request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    requestHandle.on("error", reject);
    requestHandle.end(body);
  });
}

const requestBody = JSON.stringify({
  model,
  messages: [{ role: "user", content: question }],
  stream: false,
  options: {
    temperature,
    num_predict: numPredict,
    ...(reasoningBudget === undefined ? {} : { reasoning_budget: reasoningBudget }),
  },
});
const started = performance.now();
const response = await postJson(`${gatewayUrl}/api/chat`, requestBody);
const result = JSON.parse(response.body) as Record<string, any>;
const message = result.message ?? {};
console.log(JSON.stringify({
  model,
  parameters: { temperature, num_predict: numPredict, reasoning_budget: reasoningBudget },
  status: response.status,
  wall_seconds: Math.round((performance.now() - started) / 1000),
  answer: message.content ?? "",
  thinking: message.thinking ?? "",
  error: result.error,
  done_reason: result.done_reason,
  prompt_eval_count: result.prompt_eval_count,
  eval_count: result.eval_count,
}, null, 2));
if (response.status < 200 || response.status >= 300) process.exitCode = 1;