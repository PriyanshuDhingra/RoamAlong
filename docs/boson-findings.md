# Boson findings

Results of `tools/probe_boson.py` (IMPLEMENTATION_PLAN.md §4.7). For each probe, keep three things apart: what the docs say, what we observed, what we still assume.

| # | Probe | Date | Config | Docs say | Observed | Still assumed |
|---|---|---|---|---|---|---|
| 1 | Per-response `instructions`: replace or append? | | | | | |
| 2 | Mid-session `session.update` of instructions: latency, glitches, rejected during a response? | | | | | |
| 3 | `audio.output.voice` change mid-session | | | | | |
| 4 | Code-switching with cloned voice vs `default` | | | | | |
| 5 | Proactive `response.create` with no new user input | | | | | |
| 6 | Filler before a 1.5 s client tool | | | | | |
| 7 | Does model speech reset the idle timer? | | | | | |
| 8 | `max_duration_sec` value | | | | | |
| 9 | Truncated item changes model recollection | | | | | |
| 10 | Billing: all streamed audio or detected speech only? | | | | | |
| 11 | Language switching EN ↔ FR ↔ AR ↔ HI; place names don't trigger switches | | | | | |
| — | `noise_reduction`: bare string or `{type}` object? | | | | | |
