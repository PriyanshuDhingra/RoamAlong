# Wander

A realtime, location-aware voice tour guide for Toronto, built on Boson AI's Higgs Realtime for the **Higgs Audio Hackathon 2026**. You walk with earbuds in; the guide notices what you're about to pass, tells you about it, and holds a real conversation: you can interrupt it, switch language mid-sentence, ask for directions, or ask it to be quiet.

## Layout

```
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

Map and place data © OpenStreetMap contributors (ODbL). Wikidata (CC0). Wikipedia article metadata (CC BY-SA).
