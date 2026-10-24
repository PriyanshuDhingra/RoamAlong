# Mobile feasibility matrix

Physical devices only (IMPLEMENTATION_PLAN.md §13.5). Mark each cell **works / partly / fails** with a short note. Exit criterion: one iOS and one Android configuration pass the first four rows.

Devices: iPhone ______ (iOS __), Android ______ (Android __). Library: `react-native-audio-api` __ (fallback `@siteed/expo-audio-studio` if it fails).

| Test | iPhone (wired/USB-C) | iPhone + AirPods | iPhone speaker | Android (wired) | Android + Bluetooth | Android speaker |
|---|---|---|---|---|---|---|
| Simultaneous mic streaming + gapless 24 kHz playback | | | | | | |
| Tool-assisted answer (speech → tool → speech) | | | | | | |
| Barge-in: playback stops on `stop_playback` (ms) | | | | | | |
| Self-echo false barge-ins during 2 min of guide speech | | | | | | |
| Bluetooth route switch mid-session | | | | | | |
| Network drop 10 s → reconnect, no duplicate/stale audio | | | | | | |
| Screen lock 3 min: audio, mic, location continue | | | | | | |
| App backgrounded 3 min | | | | | | |
| Phone call / notification interruption and recovery | | | | | | |
