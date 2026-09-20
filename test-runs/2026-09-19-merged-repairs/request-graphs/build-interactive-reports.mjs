import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

const reports = [
  { id: 1, slug: "request-1-spice-primary", title: "Spice Girls primary run", verdict: "Semantic fail" },
  { id: 2, slug: "request-2-spice-duplicate", title: "Spice Girls duplicate queued run", verdict: "Partial" },
  { id: 3, slug: "request-3-mlb-aggregate", title: "MLB aggregate-first route", verdict: "Incorrect aggregate answer" },
  { id: 4, slug: "request-4-mlb-30-team", title: "MLB primary 30-team list-map run", verdict: "Substantive pass" },
  { id: 5, slug: "request-5-mlb-26-team", title: "MLB duplicate queued 26-team run", verdict: "Incomplete discovery" },
];

const milestoneEvents = new Set([
  "research_list_created",
  "research_dataset_stored",
  "research_map_started",
  "research_map_completed",
  "research_repair_review_started",
  "research_repair_review_completed",
  "research_repair_started",
  "research_repair_completed",
  "research_reduce_started",
  "research_reduce_completed",
]);

function parseTrace(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap((line, lineIndex) => {
    const match = line.match(/\|\s+(\S+)\s+(\{.*\})\s*$/);
    if (!match) return [];
    try {
      return [{ ...JSON.parse(match[2]), timestamp: match[1], line: lineIndex + 1, raw: line, order: lineIndex }];
    } catch {
      return [];
    }
  });
}

function compact(value, limit = 92) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function firstLine(value) {
  return String(value ?? "").split("\n", 1)[0].trim();
}

function subjectFromQuestion(question) {
  const text = firstLine(question);
  const patterns = [
    /\bfor (.+?)\. Required meaning:/i,
    /\bfor (.+?)[.?]?$/i,
    /^Has (.+?) ever\b/i,
    /^What (?:is|are).*? of (.+?)[.?]?$/i,
    /^Who (?:is|are) (.+?)[.?]?$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return compact(match[1], 42);
  }
  return compact(text, 48);
}

function pretty(value) {
  if (value === undefined || value === null || value === "") return "Not captured in this gateway event.";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function buildAttempts(events) {
  const attempts = [];
  const latestByIndex = new Map();
  const byKey = new Map();

  function create(event, attemptNumber, retry) {
    const item = {
      id: `subagent-${event.index}-${attemptNumber}-${event.order}`,
      index: event.index,
      attempt: attemptNumber,
      retry,
      question: event.question ?? "",
      start: event.timestamp,
      startOrder: event.order,
      end: null,
      status: "running",
      answer: "",
      events: [event],
      wikiCalls: [],
      wikiResults: [],
    };
    attempts.push(item);
    latestByIndex.set(event.index, item);
    byKey.set(`${event.index}:${attemptNumber}`, item);
    return item;
  }

  for (const event of events) {
    if (event.event === "subagent_started") {
      create(event, 1, false);
      continue;
    }
    if (event.event === "subagent_retry") {
      const previous = latestByIndex.get(event.index);
      create(event, (previous?.attempt ?? 1) + 1, true);
      continue;
    }

    const index = event.index ?? event.subagent;
    if (index === undefined) continue;
    const attemptNumber = event.attempt ?? latestByIndex.get(index)?.attempt ?? 1;
    const attempt = byKey.get(`${index}:${attemptNumber}`) ?? latestByIndex.get(index);
    if (!attempt) continue;
    attempt.events.push(event);
    if (event.event === "wiki_tool_call") attempt.wikiCalls.push(event);
    if (event.event === "wiki_tool_result") attempt.wikiResults.push(event);
    if (event.event === "subagent_completed") {
      attempt.end = event.timestamp;
      attempt.endOrder = event.order;
      attempt.status = event.status ?? "complete";
      attempt.answer = event.answer ?? "";
      attempt.executionSeconds = event.executionSeconds;
      attempt.unresolved = event.unresolved ?? [];
      attempt.malformed = event.malformed ?? false;
    }
  }
  return attempts;
}

function makeNode({ id, actor, label, subtitle, tooltip, status, timestamp, input, output, rawEvents, extra }) {
  return { id, actor, label, subtitle, tooltip, status, timestamp, input, output, rawEvents, extra };
}

function attemptNode(attempt) {
  const subject = subjectFromQuestion(attempt.question);
  const retryText = attempt.retry ? `attempt ${attempt.attempt} · retry` : `attempt ${attempt.attempt}`;
  const wikiText = `${attempt.wikiCalls.length} LocalWiki call${attempt.wikiCalls.length === 1 ? "" : "s"}`;
  return makeNode({
    id: attempt.id,
    actor: "subagent",
    label: subject || `Subagent ${attempt.index}`,
    subtitle: `${retryText} · ${wikiText}`,
    tooltip: `${firstLine(attempt.question)}\nStatus: ${attempt.status}; ${wikiText}`,
    status: attempt.status,
    timestamp: attempt.start,
    input: attempt.question,
    output: attempt.answer,
    rawEvents: attempt.events.map(({ raw, ...event }) => event),
    extra: {
      "Execution": "LM Studio isolated subagent context",
      "Retrieval": attempt.wikiCalls.length ? "LocalWiki MCP (offline Wikipedia)" : "No completed LocalWiki call captured",
      "Subagent index": attempt.index,
      "Attempt": attempt.attempt,
      "Execution seconds": attempt.executionSeconds ?? "Not captured",
      "Unresolved": attempt.unresolved?.length ? attempt.unresolved.join("; ") : "None",
      "Malformed": String(Boolean(attempt.malformed)),
      "LocalWiki calls": attempt.wikiCalls.map((call, index) => ({
        sequence: index + 1,
        name: call.name,
        arguments: call.arguments,
        result: attempt.wikiResults[index]
          ? { characters: attempt.wikiResults[index].characters, isError: attempt.wikiResults[index].isError }
          : "No matching result captured",
      })),
    },
  });
}

function milestoneNode(event) {
  const labels = {
    research_list_created: ["List extracted", `${event.count} subjects`],
    research_dataset_stored: [`Dataset ${event.dataset} stored`, `${event.count} subjects`],
    research_map_started: ["Map fan-out", `${event.inputCount} records`],
    research_map_completed: [`Map ${event.map} complete`, `${event.completedCount}/${event.inputCount} records`],
    research_repair_review_started: ["Repair review input", `${event.inputCount} records`],
    research_repair_review_completed: ["Repair review output", `${event.review?.assessments?.length ?? 0} assessments`],
    research_repair_started: ["Repair plan", `${event.plannedCalls} calls / budget ${event.repairBudget}`],
    research_repair_completed: ["Repairs merged", `${event.repairCalls} calls · ${event.outputCount} records`],
    research_reduce_started: ["Reducer input", `${event.inputCount} records`],
    research_reduce_completed: ["Reducer output", `${event.answerCharacters} characters`],
  };
  const [label, subtitle] = labels[event.event] ?? [event.event, "Gateway event"];
  const llmGenerated = event.event === "research_repair_review_completed" || event.event === "research_reduce_completed";
  return makeNode({
    id: `event-${event.order}`,
    actor: llmGenerated ? "llm" : "gateway",
    label,
    subtitle,
    tooltip: `${event.event} at ${event.timestamp}`,
    status: event.event.includes("completed") ? "complete" : "normal",
    timestamp: event.timestamp,
    input: event.question ?? event.requiredFields ?? event.actions,
    output: event.review ?? event.answer ?? event.items ?? event.records,
    rawEvents: [{ ...event, raw: undefined }],
    extra: {
      "Execution": llmGenerated ? "LM Studio structured generation, orchestrated by Gateway" : "Gateway process",
      "Event": event.event,
      "Dataset": event.dataset ?? event.map ?? "Not applicable",
    },
  });
}

function toolNode(event) {
  return makeNode({
    id: `tool-${event.round}-${event.order}`,
    actor: "orchestrator",
    label: event.name,
    subtitle: `top-level round ${event.round}`,
    tooltip: `LM Studio top-level LLM selected ${event.name}. Click for exact arguments.`,
    status: "normal",
    timestamp: event.timestamp,
    input: "The complete top-level prompt is not emitted in this gateway event; see the request context and preceding stage output.",
    output: event.arguments,
    rawEvents: [{ ...event, raw: undefined }],
    extra: {
      "Execution": "LM Studio top-level orchestration LLM",
      "Direction": "LM Studio -> Gateway tool call",
      "Round": event.round,
    },
  });
}

function buildReport(config, events) {
  const attempts = buildAttempts(events);
  const tools = events.filter((event) => event.event === "lmstudio_tool_call");
  const stages = tools.map((tool, stageIndex) => {
    const endOrder = tools[stageIndex + 1]?.order ?? Number.POSITIVE_INFINITY;
    const stageAttempts = attempts.filter((attempt) => attempt.startOrder > tool.order && attempt.startOrder < endOrder);
    const milestones = events
      .filter((event) => event.order > tool.order && event.order < endOrder && milestoneEvents.has(event.event))
      .filter((event) => event.event !== "research_dataset_stored");
    return {
      id: `stage-${stageIndex + 1}`,
      number: stageIndex + 1,
      tool: toolNode(tool),
      attempts: stageAttempts.map(attemptNode),
      attemptMeta: stageAttempts.map((attempt) => ({ id: attempt.id, index: attempt.index, attempt: attempt.attempt, order: attempt.startOrder })),
      milestones: milestones.map(milestoneNode),
      milestoneMeta: milestones.map((event) => ({ id: `event-${event.order}`, order: event.order, event: event.event })),
    };
  });

  const chatRequest = events.find((event) => event.event === "chat_request");
  const chatCompleted = events.find((event) => event.event === "chat_completed");
  const chatReleased = events.find((event) => event.event === "chat_released");
  const requestNode = makeNode({
    id: "request",
    actor: "gateway",
    label: `Request ${config.id}`,
    subtitle: chatRequest?.model ?? "Gateway request",
    tooltip: `Gateway accepted request ${config.id}. Click for request metadata.`,
    status: "normal",
    timestamp: chatRequest?.timestamp ?? events[0]?.timestamp,
    input: chatRequest ? { messages: chatRequest.messages, historyReset: chatRequest.historyReset, stream: chatRequest.stream } : "Request event not captured",
    output: "Queued for request-scoped execution.",
    rawEvents: events.filter((event) => event.event === "chat_request" || event.event === "chat_started").map(({ raw, ...event }) => event),
    extra: { "Execution": "Gateway HTTP/chat orchestration", "Model": chatRequest?.model ?? "Not captured" },
  });
  const finalNode = makeNode({
    id: "final",
    actor: "orchestrator",
    label: "Final response",
    subtitle: config.verdict,
    tooltip: `LM Studio final response. ${config.verdict}. Click for completion metadata.`,
    status: /pass/i.test(config.verdict) ? "complete" : "warning",
    timestamp: chatCompleted?.timestamp,
    input: "The top-level LLM synthesized the final response from preceding tool results.",
    output: chatCompleted ? `${chatCompleted.answerCharacters} answer characters; doneReason=${chatCompleted.doneReason}` : "Completion event not captured",
    rawEvents: [chatCompleted, chatReleased].filter(Boolean).map(({ raw, ...event }) => event),
    extra: {
      "Execution": "LM Studio top-level LLM, returned through Gateway",
      "Rounds": chatCompleted?.rounds ?? "Not captured",
      "Released": chatReleased?.timestamp ?? "Not captured",
    },
  });

  return {
    requestId: config.id,
    title: config.title,
    verdict: config.verdict,
    eventCount: events.length,
    started: events[0]?.timestamp,
    ended: events.at(-1)?.timestamp,
    request: requestNode,
    stages,
    final: finalNode,
  };
}

function htmlFor(report) {
  const embedded = JSON.stringify(report).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Request ${report.requestId} · ${report.title}</title>
<style>
:root { --ink:#19222c; --muted:#68737f; --paper:#f7f8f5; --line:#cad1d8; --gateway:#2176ae; --orchestrator:#7753a5; --subagent:#117864; --warning:#bd5d16; --danger:#b23a48; }
* { box-sizing:border-box; }
body { margin:0; color:var(--ink); background:var(--paper); font:14px/1.45 "Segoe UI",sans-serif; letter-spacing:0; }
header { padding:18px 24px 14px; border-bottom:1px solid var(--line); background:#fff; }
h1 { margin:0 0 4px; font:600 24px/1.2 Georgia,serif; letter-spacing:0; }
.meta { display:flex; gap:16px; color:var(--muted); flex-wrap:wrap; }
.toolbar { display:flex; align-items:center; gap:8px; padding:10px 24px; border-bottom:1px solid var(--line); background:#eef1ed; position:sticky; top:0; z-index:5; }
.toolbar input { width:min(420px,45vw); padding:7px 10px; border:1px solid #aeb7c0; border-radius:4px; background:#fff; }
.toolbar button { width:32px; height:32px; border:1px solid #aeb7c0; background:#fff; border-radius:4px; cursor:pointer; font-weight:700; }
.legend { margin-left:auto; display:flex; gap:12px; flex-wrap:wrap; color:#46515c; font-size:12px; }
.legend span::before { content:""; display:inline-block; width:10px; height:10px; margin-right:5px; border-radius:2px; background:var(--tone); }
#viewport { overflow:auto; height:calc(100vh - 121px); padding:18px; }
#graph { display:block; background:#fff; border:1px solid var(--line); box-shadow:0 2px 12px #1b27331a; }
.stage-bg { fill:#fafbf9; stroke:#d7dde2; }
.stage-title { font:600 15px "Segoe UI",sans-serif; fill:#35414c; }
.stage-note { font:12px "Segoe UI",sans-serif; fill:#74808b; }
.edge { fill:none; stroke:#9aa5af; stroke-width:1.3; marker-end:url(#arrow); }
.edge.retry { stroke:var(--warning); stroke-dasharray:6 4; }
.node { cursor:pointer; outline:none; }
.node rect { fill:#fff; stroke:#71808d; stroke-width:1.25; rx:5; }
.node text { pointer-events:none; fill:#18232d; font:12px "Segoe UI",sans-serif; }
.node .sub { fill:#68737f; font-size:10.5px; }
.node.gateway rect { fill:#e5f3fb; stroke:var(--gateway); }
.node.orchestrator rect { fill:#eee7f7; stroke:var(--orchestrator); }
.node.subagent rect { fill:#e5f4ef; stroke:var(--subagent); }
.node.warning rect, .node.failed rect, .node.partial rect { fill:#fff0e4; stroke:var(--warning); }
.node.selected { opacity:1; }
.node.selected rect { stroke:#111820; stroke-width:3; }
.node.dim { opacity:.13; }
.actor-tag { font:700 9px "Segoe UI",sans-serif; text-transform:uppercase; }
#drawer { position:fixed; inset:0 0 0 auto; width:min(620px,92vw); background:#fff; border-left:1px solid #aeb7c0; box-shadow:-8px 0 30px #17212b2b; transform:translateX(102%); transition:transform .18s ease; z-index:20; display:flex; flex-direction:column; }
#drawer.open { transform:none; }
.drawer-head { padding:16px 18px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:flex-start; }
.drawer-head h2 { margin:0; font:600 19px/1.25 Georgia,serif; letter-spacing:0; }
.drawer-head button { margin-left:auto; border:0; background:transparent; font-size:23px; cursor:pointer; }
#details { padding:16px 18px 40px; overflow:auto; }
.detail-meta { display:grid; grid-template-columns:max-content 1fr; gap:5px 12px; margin-bottom:18px; }
.detail-meta dt { color:var(--muted); }
.detail-meta dd { margin:0; overflow-wrap:anywhere; }
h3 { margin:20px 0 7px; font-size:12px; text-transform:uppercase; color:#53606c; letter-spacing:.04em; }
pre { margin:0; padding:12px; white-space:pre-wrap; overflow-wrap:anywhere; background:#151d24; color:#e9f0f4; border-radius:5px; font:12px/1.45 Consolas,monospace; letter-spacing:0; max-height:360px; overflow:auto; }
.empty { color:var(--muted); padding:30px; }
@media (max-width:800px) { .legend { display:none; } #viewport { padding:8px; } }
</style>
</head>
<body>
<header>
  <h1>Request ${report.requestId}: ${report.title}</h1>
  <div class="meta"><span>${report.verdict}</span><span>${report.eventCount} captured events</span><span>${report.started ?? "unknown"} → ${report.ended ?? "unknown"}</span></div>
</header>
<div class="toolbar">
  <input id="search" type="search" placeholder="Search nodes, prompts, answers, tool calls…" aria-label="Search trace">
  <button id="zoom-out" title="Zoom out">−</button><button id="zoom-reset" title="Reset zoom">1:1</button><button id="zoom-in" title="Zoom in">+</button>
  <div class="legend"><span style="--tone:var(--gateway)">Gateway</span><span style="--tone:var(--orchestrator)">Top-level / structured LLM</span><span style="--tone:var(--subagent)">LM Studio subagent + LocalWiki</span><span style="--tone:var(--warning)">Retry / partial</span></div>
</div>
<main id="viewport"><svg id="graph" role="img" aria-label="Interactive execution graph"></svg></main>
<aside id="drawer" aria-label="Node details">
  <div class="drawer-head"><div><h2 id="detail-title">Node details</h2><div id="detail-subtitle" class="meta"></div></div><button id="close" title="Close details" aria-label="Close details">×</button></div>
  <div id="details"><div class="empty">Select a node to inspect exact inputs, outputs, LocalWiki calls, and raw events.</div></div>
</aside>
<script id="report-data" type="application/json">${embedded}</script>
<script>
const report = JSON.parse(document.getElementById("report-data").textContent);
const svg = document.getElementById("graph");
const ns = "http://www.w3.org/2000/svg";
const nodeWidth = 190, nodeHeight = 58, graphWidth = 1900;
let zoom = 1;
const positions = new Map(), nodesById = new Map(), edgeSpecs = [];

function el(name, attrs = {}, parent = svg) {
  const item = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, value);
  parent.appendChild(item);
  return item;
}
function lines(text, width = 27) {
  const words = String(text).split(/\s+/); const output = []; let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width && line) { output.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) output.push(line); return output.slice(0, 2);
}
function nodeSearch(node) { return JSON.stringify(node).toLowerCase(); }
function addNode(node, x, y, width = nodeWidth) {
  nodesById.set(node.id, node); positions.set(node.id, { x, y, width, height:nodeHeight });
  const group = el("g", { class:"node " + node.actor + " " + (node.status ?? ""), tabindex:"0", "data-id":node.id });
  el("title", {}, group).textContent = node.tooltip;
  el("rect", { x, y, width, height:nodeHeight }, group);
  const actor = el("text", { x:x+10, y:y+13, class:"actor-tag" }, group);
  actor.textContent = node.actor === "orchestrator" ? "LM STUDIO LLM" : node.actor === "subagent" ? "LM STUDIO + LOCALWIKI" : "GATEWAY";
  const labelLines = lines(node.label);
  labelLines.forEach((line, index) => { const text = el("text", { x:x+10, y:y+30+index*13 }, group); text.textContent=line; });
  const subtitle = el("text", { x:x+10, y:y+nodeHeight-7, class:"sub" }, group); subtitle.textContent=String(node.subtitle ?? "").slice(0, 36);
  group.dataset.search = nodeSearch(node);
  group.addEventListener("click", () => showDetails(node));
  group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") showDetails(node); });
}
function addEdge(from, to, retry = false) { if (from && to) edgeSpecs.push({ from, to, retry }); }
function finalAttemptIds(meta) {
  const latest = new Map();
  for (const item of meta) if (!latest.has(item.index) || latest.get(item.index).attempt < item.attempt) latest.set(item.index, item);
  return [...latest.values()].map(item => item.id);
}
function attemptRoots(meta) { return meta.filter(item => item.attempt === 1).map(item => item.id); }
function connectRetries(meta) {
  const groups = new Map();
  for (const item of meta) { const list = groups.get(item.index) ?? []; list.push(item); groups.set(item.index, list); }
  for (const list of groups.values()) { list.sort((a,b) => a.attempt-b.attempt); for (let i=1;i<list.length;i++) addEdge(list[i-1].id,list[i].id,true); }
}
function drawEdge(spec, layer) {
  const a=positions.get(spec.from), b=positions.get(spec.to); if(!a||!b)return;
  const x1=a.x+a.width, y1=a.y+a.height/2, x2=b.x, y2=b.y+b.height/2, bend=Math.max(28,(x2-x1)*.45);
  el("path", { d:"M " + x1 + " " + y1 + " C " + (x1+bend) + " " + y1 + ", " + (x2-bend) + " " + y2 + ", " + x2 + " " + y2, class:"edge" + (spec.retry?" retry":"") }, layer);
}
function showDetails(node) {
  document.querySelectorAll(".node.selected").forEach(item=>item.classList.remove("selected"));
  document.querySelector('[data-id="' + CSS.escape(node.id) + '"]')?.classList.add("selected");
  document.getElementById("detail-title").textContent=node.label;
  document.getElementById("detail-subtitle").textContent=node.subtitle ?? "";
  const metadata=Object.entries({ Actor:node.actor, Timestamp:node.timestamp, Status:node.status, ...node.extra });
  const metadataHtml=metadata.map(([k,v])=>"<dt>"+escapeHtml(k)+"</dt><dd>"+escapeHtml(typeof v==="object"?JSON.stringify(v):v)+"</dd>").join("");
  document.getElementById("details").innerHTML='<dl class="detail-meta">'+metadataHtml+"</dl>"+section("Input / prompt",node.input)+section("Output / response",node.output)+section("Raw captured events",node.rawEvents);
  document.getElementById("drawer").classList.add("open");
}
function escapeHtml(value) { return String(value??"").replace(/[&<>"']/g, char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
function section(title,value) { const text=typeof value==="string"?value:JSON.stringify(value,null,2); return "<h3>"+escapeHtml(title)+"</h3><pre>"+escapeHtml(text||"Not captured")+"</pre>"; }

const defs=el("defs"); const marker=el("marker",{id:"arrow",viewBox:"0 0 10 10",refX:"9",refY:"5",markerWidth:"6",markerHeight:"6",orient:"auto-start-reverse"},defs); el("path",{d:"M 0 0 L 10 5 L 0 10 z",fill:"#9aa5af"},marker);
const edgeLayer=el("g",{class:"edges"}); const nodeLayer=el("g",{class:"nodes"});
let y=36; addNode(report.request,50,y); let previous=[report.request.id]; y+=105;
for (const stage of report.stages) {
  const firstAttemptOrder=Math.min(...stage.attemptMeta.map(item=>item.order),Infinity);
  const pre=stage.milestones.filter((_,i)=>stage.milestoneMeta[i].order<firstAttemptOrder);
  const post=stage.milestones.filter((_,i)=>stage.milestoneMeta[i].order>=firstAttemptOrder);
  const attemptStartX=Math.max(650,325+pre.length*205);
  const attemptColumns=Math.max(1,Math.floor((1430-attemptStartX)/215)+1);
  const attemptRows=Math.max(1,Math.ceil(stage.attempts.length/attemptColumns));
  const stageHeight=Math.max(190,attemptRows*82+105,stage.milestones.length*72+80);
  el("rect",{x:22,y:y-30,width:graphWidth-44,height:stageHeight,class:"stage-bg"},nodeLayer);
  const heading=el("text",{x:42,y:y-7,class:"stage-title"},nodeLayer); heading.textContent="Round "+stage.number+": "+stage.tool.label;
  const note=el("text",{x:260,y:y-7,class:"stage-note"},nodeLayer); note.textContent=stage.attempts.length+" subagent attempt"+(stage.attempts.length===1?"":"s")+" · "+stage.milestones.length+" gateway/structured milestone"+(stage.milestones.length===1?"":"s");
  addNode(stage.tool,50,y);
  previous.forEach(id=>addEdge(id,stage.tool.id));
  let entry=stage.tool.id;
  pre.forEach((node,index)=>{ addNode(node,285+index*205,y); addEdge(entry,node.id); entry=node.id; });
  stage.attempts.forEach((node,index)=>addNode(node,attemptStartX+((index%attemptColumns)*215),y+Math.floor(index/attemptColumns)*82));
  attemptRoots(stage.attemptMeta).forEach(id=>addEdge(entry,id));
  connectRetries(stage.attemptMeta);
  let exits=stage.attempts.length?finalAttemptIds(stage.attemptMeta):[entry];
  post.forEach((node,index)=>{ addNode(node,1645,y+index*72); exits.forEach(id=>addEdge(id,node.id)); exits=[node.id]; });
  previous=exits.length?exits:[entry]; y+=stageHeight+42;
}
addNode(report.final,50,y); previous.forEach(id=>addEdge(id,report.final.id)); y+=95;
edgeSpecs.forEach(spec=>drawEdge(spec,edgeLayer));
svg.setAttribute("viewBox","0 0 "+graphWidth+" "+y); svg.style.width=graphWidth+"px"; svg.style.height=y+"px";

function setZoom(next) { zoom=Math.max(.55,Math.min(1.8,next)); svg.style.width=(graphWidth*zoom)+"px"; svg.style.height=(y*zoom)+"px"; }
document.getElementById("zoom-in").onclick=()=>setZoom(zoom+.15);
document.getElementById("zoom-out").onclick=()=>setZoom(zoom-.15);
document.getElementById("zoom-reset").onclick=()=>setZoom(1);
document.getElementById("close").onclick=()=>document.getElementById("drawer").classList.remove("open");
document.addEventListener("keydown",event=>{if(event.key==="Escape")document.getElementById("drawer").classList.remove("open");});
document.getElementById("search").addEventListener("input",event=>{const q=event.target.value.trim().toLowerCase();document.querySelectorAll(".node").forEach(node=>node.classList.toggle("dim",Boolean(q)&&!node.dataset.search.includes(q)));});
</script>
</body>
</html>`;
}

const onlyRequest = process.argv[2] ? Number(process.argv[2]) : null;
for (const config of reports.filter((item) => onlyRequest === null || item.id === onlyRequest)) {
  const rawPath = path.join(directory, `request-${config.id}-raw.log`);
  if (!fs.existsSync(rawPath)) throw new Error(`Missing trace: ${rawPath}`);
  const events = parseTrace(rawPath);
  if (!events.length) throw new Error(`No parseable events in ${rawPath}`);
  const report = buildReport(config, events);
  const outputPath = path.join(directory, `${config.slug}.html`);
  fs.writeFileSync(outputPath, htmlFor(report), "utf8");
  console.log(`${path.basename(outputPath)}: ${events.length} events, ${report.stages.length} stages`);
}
