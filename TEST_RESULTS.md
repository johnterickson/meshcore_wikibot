# Current Gateway Test Results

Recorded on 2026-09-18 with `nvidia/nemotron-3-nano-4b`, temperature `0.2`, and a 2,048-token prediction limit.

## Summary

| Test | Status | Wall time | Result |
| --- | --- | ---: | --- |
| Mariners | Pass | 156.863 seconds | Returned only the Seattle Mariners from fetched drought-table evidence |
| Spice Girls | Pass | 238.338 seconds | Returned all five stage/legal-name mappings and birthdays |

## Mariners

**Status:** Pass

**Visible answer:** The only active MLB team that has never made a World Series appearance is the Seattle Mariners.

The parent discovered all 30 active teams, attempted an invalid map template without `{item}`, accepted the validation error, and switched to aggregate research. The aggregate researcher fetched the `Longest current World Series appearance droughts` table and returned the explicit Seattle Mariners result. This run did not invoke map repair.

## Spice Girls

**Status:** Pass

```text
Mel B - Melanie Janine Brown - 1975/05/29
Emma Bunton - Emma Lee Bunton - 1976/01/21
Melanie C - Melanie Jayne Chisholm - 1974/01/12
Posh (Victoria Beckham) - Victoria Caroline Adams - 1974/04/17
Geri Halliwell - Geraldine Estelle Halliwell - 1972/08/06
```

Discovery produced the five people without inserting the group or omitting Victoria Beckham. Map expanded all three `{item}` occurrences in every question and completed 5/5 records with fetched evidence. The structured repair review found no incomplete, mismatched, extra, or missing records and requested zero actions before final reduction.

Full benchmark output, UTC windows, and timestamp-bounded gateway logs are under `test-runs/2026-09-18-repair`.

## Infrastructure validation

- A synthetic 30-record dataset returned only `{"dataset":"D1","count":30}` to the parent while retaining all names internally.
- Map processed 30/30 records, from the first through the last, and reduce received all 30 results.
- A focused regression test verifies that every `{item}` occurrence in a map template is expanded.
- Map records now expose generic completion status and unresolved fields; reduction performs one bounded structured repair review before synthesis.
- A live Ollama stream emitted `done:false` progress before research completed and ended with one `done:true` answer.
- A complete atomic stream emitted research, retry, and completion updates, then correctly answered Victoria Beckham's birthday as `1974/04/17`.
- A child context-overflow failure originally aborted a long map. Researchers now truncate older middle turns under context pressure and isolate remaining prediction failures to one retried item.
- A live two-client test confirmed gateway-wide serialization: the first request started research, while the second received `Queued for the model (position 1)` and did not start inference.
- The repaired Mariners and Spice Girls runs both completed sequentially with HTTP 200, correct graded answers, complete correlated logs, and normal mutex release.
