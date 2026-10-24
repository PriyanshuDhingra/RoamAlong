"""Wikipedia text for entities with an English article (§10.4 step 5), demo-sized.

For hero places (pipeline/curated/hero_places.json) we keep the lead section plus the main sections, chunked to
~200 words; for every other linked entity, just the lead (intro). The guide speaks only from this material and
Wikidata facts, so this is what keeps it grounded.

Output: data/staging/wiki_chunks.jsonl  {entity_id, title, section, text, source_url, license}
Wikipedia text is CC BY-SA 4.0: keep source_url with anything derived from it.
"""

from __future__ import annotations

import json
import re

from pipeline.common import ROOT, STAGING, http_client, read_jsonl, request_with_retry, write_jsonl

API = "https://en.wikipedia.org/w/api.php"
HEROES = ROOT / "pipeline" / "curated" / "hero_places.json"
SKIP_SECTIONS = {"see also", "references", "notes", "external links", "further reading", "bibliography",
                 "gallery", "sources", "citations", "footnotes"}
CHUNK_WORDS = 200


def chunk(text: str, n: int = CHUNK_WORDS) -> list[str]:
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    out, cur = [], []
    for p in paras:
        words = p.split()
        if cur and len(cur) + len(words) > n:
            out.append(" ".join(cur))
            cur = []
        cur += words
    if cur:
        out.append(" ".join(cur))
    return out


def split_sections(text: str) -> list[tuple[str, str]]:
    """Plain-text extract -> [(section title, body)], using the `== Heading ==` markers explaintext keeps."""
    parts = re.split(r"\n\s*(={2,})\s*(.+?)\s*\1\s*\n", "\n" + text)
    sections = [("Lead", parts[0])]
    for i in range(1, len(parts) - 2, 3):
        sections.append((parts[i + 1], parts[i + 2]))
    return [(t, b.strip()) for t, b in sections if b.strip() and t.lower() not in SKIP_SECTIONS]


def main() -> None:
    hero_ids = {p["id"] for p in json.loads(HEROES.read_text())["places"]}
    ents = [e for e in read_jsonl(STAGING / "entities.jsonl") if e["attrs"].get("wd", {}).get("enwiki")]
    rows = []
    with http_client() as client:
        heroes = [e for e in ents if e["id"] in hero_ids]
        for e in heroes:  # full article, one request each (extracts only return full text for one page at a time)
            title = e["attrs"]["wd"]["enwiki"]
            r = request_with_retry(client, "GET", API, params={
                "action": "query", "prop": "extracts", "explaintext": 1, "titles": title, "redirects": 1, "format": "json"})
            page = next(iter(r.json()["query"]["pages"].values()))
            url = "https://en.wikipedia.org/wiki/" + title.replace(" ", "_")
            for section, body in split_sections(page.get("extract", "")):
                for c in chunk(body):
                    rows.append({"entity_id": e["id"], "title": title, "section": section, "text": c,
                                 "source_url": url, "license": "CC BY-SA 4.0", "hero": True})
        others = [e for e in ents if e["id"] not in hero_ids]
        for i in range(0, len(others), 20):  # intros only, 20 per request (API limit for exintro)
            batch = others[i:i + 20]
            by_title = {e["attrs"]["wd"]["enwiki"]: e for e in batch}
            r = request_with_retry(client, "GET", API, params={
                "action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1, "exlimit": 20,
                "titles": "|".join(by_title), "redirects": 1, "format": "json"})
            q = r.json()["query"]
            back = {x["to"]: x["from"] for x in q.get("redirects", []) + q.get("normalized", [])}
            for page in q["pages"].values():
                t = page.get("title", "")
                e = by_title.get(t) or by_title.get(back.get(t, ""))
                if e and page.get("extract"):
                    url = "https://en.wikipedia.org/wiki/" + page["title"].replace(" ", "_")
                    rows.append({"entity_id": e["id"], "title": page["title"], "section": "Lead",
                                 "text": chunk(page["extract"])[0], "source_url": url, "license": "CC BY-SA 4.0",
                                 "hero": False})
    n = write_jsonl(STAGING / "wiki_chunks.jsonl", rows)
    print(f"chunks: {n}  hero chunks: {sum(r['hero'] for r in rows)}  "
          f"entities covered: {len({r['entity_id'] for r in rows})}")


if __name__ == "__main__":
    main()
