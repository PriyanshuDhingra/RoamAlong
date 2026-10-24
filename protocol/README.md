# App ↔ Gateway protocol

One WebSocket per session: `wss://<backend>/v1/session?token=<device-token>`.

- **JSON text frames** are defined in [`messages.schema.json`](messages.schema.json), discriminated by `type`. `UplinkMessage` is app → gateway, `DownlinkMessage` is gateway → app.
- **Binary frames** carry audio:
  - Uplink: PCM16 little-endian, mono, 16 kHz, 20 ms per frame (640 bytes). No header.
  - Downlink: PCM16 little-endian, mono, 24 kHz, as received from Boson, prefixed by a 12-byte header:

    | bytes | field |
    |---|---|
    | 0–7 | `item_id` hash: first 8 bytes of SHA-1 of the Boson `item_id` |
    | 8–11 | chunk sequence number, uint32 big-endian, starting at 0 per item |

    The app reports `playback.played_ms` per `item_id` and drops chunks for items it was told to stop (§5.7).

## Generated types

Don't edit `gen/` by hand. After changing the schema:

```bash
protocol/generate.sh
```

This writes `gen/ts/messages.ts` (for `apps/mobile` and `apps/debug-web`) and `gen/py/messages.py` (pydantic v2, for the backend). Example messages in `examples/` are validated by `backend/tests/test_protocol.py`.
