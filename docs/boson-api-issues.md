# Boson API issues and inconsistencies

Bugs, doc mismatches and surprising behaviour we hit with Higgs Realtime while building Wander. Each entry has a
repro, what the docs say, what we observed, and our workaround. Reproductions: `uv run python tools/repro_boson_issues.py`
(numbered cases below match the script's output). Probe results that behaved as documented live in
[boson-findings.md](boson-findings.md).

Environment for all entries: `wss://api.boson.ai/v1/realtime?model=higgs-realtime`, voice `default`, `semantic_vad`,
`higgs-stt-3.1` transcription, text user items via `conversation.item.create`. Dates are local (America/Toronto).

---

## 1. Per-response `max_output_tokens` makes the model ignore the conversation — **bug**

*Found 2026-10-23, reproduced 3 times.*

**Repro** (case 3): add a user item ("Who designed University College in Toronto?"), then
`{"type": "response.create", "response": {"max_output_tokens": 320}}`.

**Docs say** (client events → `response.create`): `max_output_tokens` is an "Output token cap for this response only".

**Observed:** the reply ignores the user item entirely: *"Hello! How can I help you today?"*. The same request
without the field (case 1), or with only `response.metadata` (case 2), answers the question. No `error` event.

**Workaround:** never send per-response `max_output_tokens`; control length through instructions.

## 2. Per-response `instructions` also drop the conversation context — **bug or undocumented semantics**

*Found 2026-10-23, reproduced 3 times.*

**Repro** (case 4): same user item, then `{"type": "response.create", "response": {"instructions": "<same text as the
session instructions>"}}`.

**Docs say:** `instructions` is the "System prompt for this response". Nothing says the conversation is excluded.

**Observed:** the model greets generically instead of answering (*"Hello! I'm here to guide you through ... How can I
assist you today?"*), even though the instructions are identical to the session's. Our probe 1 ("replace or append?")
didn't catch this because its test turn was "say hello" too.

It looks as if any `response` body other than `metadata` makes the response run without the conversation (similar to
OpenAI's out-of-band responses with `input: []`), but the docs describe `input` as "Message items to respond to ...
also appended to the conversation", which suggests the conversation is used by default.

**Workaround:** for turns that need different instructions (proactive hooks), send `session.update` with the briefing
in `instructions`, then a bare `response.create` (`metadata` only), then `session.update` back to the normal
instructions. `session.update` is acknowledged in ~25 ms even mid-response (findings, probe 2), so this costs little.

## 3. Session `max_output_tokens` barely limits spoken length — **inconsistency / unclear unit**

*Found 2026-10-23.*

**Docs say:** `max_output_tokens` is a "Per-response cap; integer or `"inf"`", clamped to 4096.

**Observed:** with `max_output_tokens: 160`, a "tell me the whole story" request produced **56 s** of audio; with 600,
99.8 s. Either the unit isn't text tokens, or the cap isn't applied to audio. Unlike issue 1, the session-level
setting does keep the conversation.

**Workaround:** length is controlled by instructions; keep a high session cap only as a runaway guard.

## 3b. Bare `response.create` after an assistant turn is rejected with "No user input" — **doc mismatch**

*Found 2026-10-24 00:4x, in the gateway's proactive path.*

**Repro:** a conversation whose last item is an assistant reply; send `session.update` (new instructions), then
`{"type": "response.create", "response": {"metadata": {...}}}` with no new user item.

**Docs say** (`response.create`): "Without a `response` body, the response is generated from the current
conversation and session configuration." Nothing requires a new user item.

**Observed:** `error` `{"type": "", "code": "400", "message": "No user input"}`; no `response.created`. Note the empty
`type`. Yet probe 5 (a fresh session, `response.create` with per-response `instructions` and no user item at all)
was accepted, so the rule seems to apply only when the response body has no `instructions`.

**Workaround:** for proactive turns insert a user-role text item framed as an app event
(`"[APP EVENT — not spoken by the user] …"`) with the briefing, then a plain `response.create` (plan §4.4 fallback).
Also reset the gateway's "response in progress" flag on any `error` that arrives before `response.created`.

## 4. Per-response limits in instructions are loosely followed — **model behaviour**

A proactive BRIEFING asking for "about 10 seconds, 2 sentences" produced 13.7 s (probe 5). Not an API bug, but it
means there is currently no reliable way to bound a turn's length (see 1 and 3).

## 5. Ungrounded factual answers are confidently wrong — **model behaviour**

Without our data in the prompt, the same question gets a different wrong architect each time: E. J. Lennox, John
Ostell, George Heriot, William Thomas Young (correct: Cumberland & Storm; "William Storm" appears in two answers).
Also "Toronto Reference Library" for the pink Ontario Legislative Building, ROM at "327 Bloor Street East" with a
crystal by "Viljo Revell", the Canadian Museum of Nature (Ottawa) "near Queen's Park". We ground every turn with the
SITUATION block and tool results.

## 6. Arabic replies mix in English fragments — **model behaviour**

In probe 11 the Arabic reply contained hybrids such as "ت-designed" and "لل-reference". Switching itself worked.

---

## Behaving as documented (for contrast)

- `session.update` mid-response is accepted (~26 ms) and applies to later turns.
- `conversation.item.truncate` changes what the model remembers saying.
- Fillers before a slow client tool, `response.metadata` echo on `response.created`, `noise_reduction` object form.
