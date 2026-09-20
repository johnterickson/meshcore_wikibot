# Request graphs

Each captured request has a standalone interactive HTML report, a Graphviz DOT file, and a request-scoped raw gateway trace. The HTML report is the primary view: it needs no extension, server, or external dependency.

| Request | Interactive report | Route |
| --- | --- | --- |
| 1 | `request-1-spice-primary.html` | Whole-question attempt, five-item list/map, two map retries, and five field repairs |
| 2 | `request-2-spice-duplicate.html` | Whole-question attempt, then five-item list/map and one record repair |
| 3 | `request-3-mlb-aggregate.html` | One aggregate research subagent |
| 4 | `request-4-mlb-30-team.html` | Thirty-item list/map with six execution retries and two record repairs |
| 5 | `request-5-mlb-26-team.html` | Twenty-six-item list/map with one execution retry, three field repairs, and two post-reduce questions |

## Execution labels

- `[Gateway]`: request queueing, datasets, fan-out, retry planning, status, and merge logic in the gateway process.
- `[LM Studio top-level LLM]`: orchestration tool selection and final chat synthesis.
- `[LM Studio LLM]`: structured review or reduction generation.
- `[LM Studio subagent]`: an isolated research generation context.
- `[LocalWiki MCP]`: offline Wikipedia search, section listing, and fetch calls made by a subagent.
- `[LLM + Wiki]`: a compact node representing the repeated LM Studio subagent and LocalWiki MCP tool loop for one mapped item.

Orange dashed edges are execution retries or review-triggered repairs. Map fan-out is logical; the gateway executed these subagents serially.

## HTML interaction

- Hover over a node for a concise native SVG tooltip.
- Click a node to open its exact input, output, execution metadata, LocalWiki calls, and raw captured events.
- Search prompts, answers, subjects, statuses, and tool calls from the toolbar.
- Use the toolbar controls to zoom. Large fan-outs scroll within the graph viewport.
- Open an HTML file directly in a browser. All trace JSON, SVG rendering code, styles, and scripts are embedded.

Regenerate every report from the sibling raw logs with:

```powershell
node build-interactive-reports.mjs
```

## DOT fallback

When rendered as SVG by Graphviz or a compatible VS Code DOT preview:

- Hover over a node to see its `tooltip`, including inputs, outputs, status, or routing details.
- Click a node to open the sibling `request-N-raw.log` file.
- The raw trace preserves the original JSON event lines, including `lmstudio_tool_call`, `subagent_started`, LocalWiki calls/results, `subagent_completed`, review JSON, repair plans, and reducer output.

Render one graph with:

```powershell
dot -Tsvg request-4-mlb-30-team.dot -o request-4-mlb-30-team.svg
```

Graphviz is not currently installed in this environment, so SVG files were not generated here.
