# Gateway Test Cases

Common settings:

- Model: `nvidia/nemotron-3-nano-4b`
- Temperature: `0.2`
- Prediction limit: `2048`
- `/new` starts an empty conversation context

## Mariners

```text
/new Which active MLB teams have never been to the World Series?
```

Expected answer: Seattle Mariners only. Grade "been to" as a World Series appearance, not a championship win.

```powershell
docker compose exec -T home-assistant-gateway `
  node dist/benchmark.js nvidia/nemotron-3-nano-4b `
  --question "/new Which active MLB teams have never been to the World Series?" `
  --num-predict 2048 --temperature 0.2
```

## Spice Girls

```text
/new Who are the Spice Girls (stage names in the form "[adjective] Spice" and real names) and what are their birthdays YYYY/MM/DD?
```

Expected answer:

| Stage name | Real name | Birthday |
| --- | --- | --- |
| Scary Spice | Melanie Janine Brown | 1975/05/29 |
| Sporty Spice | Melanie Jayne Chisholm | 1974/01/12 |
| Baby Spice | Emma Lee Bunton | 1976/01/21 |
| Ginger Spice | Geraldine Estelle Halliwell | 1972/08/06 |
| Posh Spice | Victoria Caroline Adams | 1974/04/17 |

```powershell
docker compose exec -T home-assistant-gateway `
  node dist/benchmark.js nvidia/nemotron-3-nano-4b `
  --question "/new Who are the Spice Girls (stage names in the form `"[adjective] Spice`" and real names) and what are their birthdays YYYY/MM/DD?" `
  --num-predict 2048 --temperature 0.2
```
