# Wander

A realtime, location-aware voice tour guide for Toronto, built on Boson AI's Higgs Realtime for the **Higgs Audio Hackathon 2026**. You walk with earbuds in; the guide notices what you're about to pass, tells you about it, and holds a real conversation: you can interrupt it, switch language mid-sentence, ask for directions, or ask it to be quiet.

Full design: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Status

Phase 0 (foundations), in progress:

- [ ] Expo dev build + mobile feasibility spike (needs Xcode, Android Studio, physical devices)
- [ ] Pick the 20–30 hero places from the coverage report

## Layout

```
pipeline/    offline ingestion: OSM, Wikidata, linking
protocol/    messages.schema.json (source of truth) + generated types in gen/
data/        raw/ and staging/ are gitignored and rebuilt by `make data`; reports/ is committed
docs/        Boson probe findings, device matrix
server/      live tour API: place research, routes, Boson session tokens
app/         live web and phone guide
```

## Setup

Requires Node 20+.

```bash
cp .env.example .env          # then fill in BOSON_API_KEY and the AZURE_OPENAI_* values
npm install
npm run dev                   # API on :3000 and the web guide
```

## Data and attribution

Map and place data © OpenStreetMap contributors (ODbL). Wikidata (CC0). Wikipedia article metadata (CC BY-SA). Per-source terms and gaps: [pipeline/SOURCES.md](pipeline/SOURCES.md).
