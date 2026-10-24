# Boson findings

Results of `tools/probe_boson.py` (IMPLEMENTATION_PLAN.md §4.7), run 2026-10-23 against `wss://api.boson.ai/v1/realtime?model=higgs-realtime`, voice `default`, `semantic_vad`, text input. Raw logs: `data/probes/20261023-233040.json`, `data/probes/20261023-233148.json`.

| # | Probe | Docs say | Observed | Still assumed / to do |
|---|---|---|---|---|
| 1 | Per-response `instructions`: replace or append? | "System prompt for this response" | **Replace.** Session rule ("end with PINEAPPLE") was followed without per-response instructions and dropped with them. | Always send the full composed prompt per response (as planned). |
| 2 | Mid-session `session.update` of instructions | Acknowledged with `session.updated` | **Accepted even during an active response**: acked in 24 ms idle, 26 ms mid-response, no audible glitch, in-flight story continued. Next turn used the new location. | Debounce anyway (§4.4). |
| 3 | Change `audio.output.voice` mid-session | — | Not run (we use `default`). | Guest-voice handoff is out of scope. |
| 4 | Code-switching, cloned vs default voice | — | Not run (no cloned voice). | — |
| 5 | Proactive `response.create`, no user input | — | **Works.** Spoke naturally from the BRIEFING, used the hook and look-for cue, ended with an offer. First audio 263 ms. Ran 13.7 s against a "~10 s" constraint. | Enforce length with `max_output_tokens` per response, not only instructions. |
| 6 | Filler before a 1.5 s client tool | — | **Yes.** "Let me check the opening year for you." before the call, then the answer from the tool result. | — |
| 7 | Does model speech reset the idle timer? | Idle = 5 min "without detected user speech" | Not run (5+ min). | Assume no: session rotation still needed (§4.5). |
| 8 | `max_duration_sec` | Sent in `session.max_duration_reached` | Not run. | Log it when it happens. |
| 9 | Truncate changes recollection? | "so the stored transcript matches the audio played" | **Yes.** After truncating at 1.2 s, the model said it hadn't named any animals yet. | — |
| 10 | Billing: all streamed audio or detected speech? | — | Not measured. | Check the billing page after a long mic session. |
| 11 | Language switching EN → FR → AR → HI → mixed | 100+ languages, auto-detected | **All six turns answered in the right language/script**; first audio 256–569 ms (Hindi slowest). "what does 'Yorkville' mean?" and "Musée royal de l'Ontario" in English sentences did **not** trigger a switch. Arabic reply mixed in English fragments ("ت-designed"). | — |
| — | `noise_reduction` form | `{"type": "near_field"}` (client-events reference) | — | Use the object form. |

## Most important finding: ungrounded answers are confidently wrong

With no place data in the prompt the model invents specifics: it called the pink Ontario Legislative Building the "Toronto Reference Library", put the ROM at "327 Bloor Street East" with a crystal by "Viljo Revell" (it's 100 Queen's Park; Daniel Libeskind), suggested the Canadian Museum of Nature (Ottawa) "near Queen's Park", and an unprompted story ran 151 s. So:

- Every turn needs the SITUATION block with nearby entities and sourced facts, plus the facts-only rule (§5.6).
- Set `max_output_tokens` per response (proactive ≈ 120, answers ≈ 250) — no default cap applies.
- `web_search` should be enabled for anything not in our data.

## Other observations

- First audio after `response.create`: 224–569 ms for text-triggered turns.
- `session.created` arrives only after the first `session.update` (nothing on connect), as documented.
