# Wander iOS app (Expo)

Expo SDK 58 development build (not Expo Go: the audio and map modules are native). Same protocol as the web debug
client: [protocol/README.md](../../protocol/README.md).

| Piece | Library | File |
|---|---|---|
| Mic (16 kHz PCM16, 20 ms) + playback (24 kHz buffer queue, flush on barge-in) | `react-native-audio-api` | `src/wander/audio.ts` |
| Gateway session, reconnect, downlink handling | WebSocket | `src/wander/session.ts` |
| GPS + compass, simulated demo walk, long-press teleport | `expo-location` | `src/wander/location.ts` |
| Map: hero outlines, 3D focus, route, user puck | `@maplibre/maplibre-react-native` | `src/app/index.tsx` |

## Run on an iPhone (same Wi-Fi as the Mac)

1. Start the gateway on the network: `uv run uvicorn backend.gateway.main:app --host 0.0.0.0 --port 8000` (repo root).
2. `apps/mobile/.env.local`: `EXPO_PUBLIC_GATEWAY_URL=ws://<mac-ip>:8000`
3. Plug in the iPhone (Developer Mode on, unlocked), then:

```bash
cd apps/mobile
npx expo run:ios --device
```

Signing uses the team in `app.json` (`ios.appleTeamId`). With a free Apple account, trust the developer profile on
the phone once: Settings → General → VPN & Device Management.

## Run outdoors (no shared Wi-Fi)

Build a Release configuration so the JavaScript is embedded (`npx expo run:ios --device --configuration Release`),
expose the gateway through an HTTPS tunnel with `WANDER_ACCESS_TOKEN` set, and paste
`wss://<tunnel-host>?token=<token>` into the app's settings sheet (tap the status pill).

Use earbuds: on the phone speaker the guide hears itself.
