"""Minimal reproductions for docs/boson-api-issues.md. Each case opens a fresh Higgs Realtime session, adds one user
text item, sends response.create (with or without per-response overrides) and prints what the model said.

    uv run python tools/repro_boson_issues.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe_boson import Session

QUESTION = "Who designed University College in Toronto?"
BASE = "You are a Toronto tour guide. Reply in one sentence."


async def case(label: str, response: dict | None, **session: object) -> None:
    s = await Session.open(instructions=BASE, **session)
    await s.say(QUESTION)
    await s.send({"type": "response.create", **({"response": response} if response is not None else {})})
    r = await s.respond(send=False)
    print(f"{label:<44} {r.audio_ms / 1000:5.1f}s  {r.transcript.strip()[:110]!r}  errors={r.errors}")
    await s.close()


async def main() -> None:
    print(f"user item: {QUESTION!r}\n")
    await case("1. no response body (control)", None)
    await case("2. response.metadata only", {"metadata": {"purpose": "answer"}})
    await case("3. response.max_output_tokens=320", {"max_output_tokens": 320})
    await case("4. response.instructions", {"instructions": BASE})
    await case("5. session max_output_tokens=160, long ask", None, max_output_tokens=160)


if __name__ == "__main__":
    asyncio.run(main())
