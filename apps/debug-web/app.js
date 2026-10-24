// Wander web debug client (IMPLEMENTATION_PLAN.md §15.2): same protocol as the phone app, laptop mic, simulated
// location. Message shapes: protocol/messages.schema.json. Binary downlink frames: 8-byte item hash + uint32 seq + PCM.

const START = { lat: 43.66205, lon: -79.39560 }; // King's College Circle
// Loop around Queen's Park: UC -> Hart House -> Legislature -> through the park -> Victoria -> ROM -> Philosopher's Walk
const DEMO_TRACK = [
  [43.66170, -79.39535], [43.66230, -79.39550], [43.66300, -79.39500], [43.66360, -79.39400], [43.66300, -79.39320],
  [43.66270, -79.39300], [43.66180, -79.39200], [43.66330, -79.39190], [43.66480, -79.39220], [43.66620, -79.39260],
  [43.66700, -79.39200], [43.66780, -79.39350], [43.66770, -79.39510], [43.66700, -79.39530], [43.66620, -79.39560],
  [43.66530, -79.39590], [43.66470, -79.39620],
];

const $ = (id) => document.getElementById(id);
const state = { lat: START.lat, lon: START.lon, heading: 45, speed: 0, ws: null, ctx: null, player: null, mic: null,
                micOn: false, walk: null, paused: false, hashToItem: new Map(), partial: new Map(), focusTimer: null };

// ---------------------------------------------------------------- map

const map = new maplibregl.Map({
  container: "map", style: "https://tiles.openfreemap.org/styles/positron", center: [START.lon, START.lat], zoom: 16.3,
  pitch: 35, attributionControl: { compact: true },
});
const empty = { type: "FeatureCollection", features: [] };

map.on("load", async () => {
  for (const id of ["heroes", "focus", "route", "user", "trail"]) map.addSource(id, { type: "geojson", data: empty });
  map.addLayer({ id: "heroes-fill", type: "fill", source: "heroes", filter: ["==", ["geometry-type"], "Polygon"],
                 paint: { "fill-color": "#d9480f", "fill-opacity": 0.12 } });
  map.addLayer({ id: "heroes-line", type: "line", source: "heroes",
                 paint: { "line-color": "#d9480f", "line-opacity": 0.6, "line-width": 1.5 } });
  map.addLayer({ id: "heroes-label", type: "symbol", source: "heroes", layout: {
    "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1], "text-optional": true,
    "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#8a3a12", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  map.addLayer({ id: "route-line", type: "line", source: "route",
                 paint: { "line-color": "#1c64f2", "line-width": 5, "line-opacity": 0.8 } });
  map.addLayer({ id: "focus-3d", type: "fill-extrusion", source: "focus", filter: ["==", ["geometry-type"], "Polygon"],
                 paint: { "fill-extrusion-color": "#d9480f", "fill-extrusion-opacity": 0.75,
                          "fill-extrusion-height": ["coalesce", ["get", "height_m"], 14] } });
  map.addLayer({ id: "focus-line", type: "line", source: "focus", filter: ["==", ["geometry-type"], "LineString"],
                 paint: { "line-color": "#d9480f", "line-width": 6, "line-dasharray": [1, 1] } });
  map.addLayer({ id: "focus-point", type: "circle", source: "focus", filter: ["==", ["geometry-type"], "Point"],
                 paint: { "circle-radius": 9, "circle-color": "#d9480f", "circle-stroke-color": "#fff",
                          "circle-stroke-width": 2 } });
  map.addLayer({ id: "focus-badge", type: "symbol", source: "focus", layout: { "text-field": ["get", "badge"],
                 "text-size": 18, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true },
                 paint: { "text-color": "#fff", "text-halo-color": "#d9480f", "text-halo-width": 3 } });
  map.addLayer({ id: "trail-line", type: "line", source: "trail",
                 paint: { "line-color": "#1c64f2", "line-width": 2, "line-opacity": 0.35 } });
  map.addLayer({ id: "user-dot", type: "circle", source: "user",
                 paint: { "circle-radius": 8, "circle-color": "#1c64f2", "circle-stroke-color": "#fff",
                          "circle-stroke-width": 3 } });
  map.addLayer({ id: "user-heading", type: "symbol", source: "user", layout: {
    "text-field": "▲", "text-size": 14, "text-rotate": ["get", "heading"], "text-rotation-alignment": "map",
    "text-offset": [0, -1.6], "text-allow-overlap": true, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": "#1c64f2" } });
  const heroes = await (await fetch("/v1/places/heroes")).json();
  heroes.features = heroes.features.map(polygonsAsRings);
  map.getSource("heroes").setData(heroes);
  drawUser();
});

// Split MultiPolygons so the "Polygon" filters above catch them too.
function polygonsAsRings(f) {
  if (f.geometry.type === "MultiPolygon") return { ...f, geometry: { type: "Polygon", coordinates: f.geometry.coordinates[0] } };
  if (f.geometry.type === "MultiLineString") return { ...f, geometry: { type: "LineString", coordinates: f.geometry.coordinates.flat() } };
  return f;
}

const trail = [];
function drawUser() {
  if (!map.getSource("user")) return;
  map.getSource("user").setData({ type: "Feature", geometry: { type: "Point", coordinates: [state.lon, state.lat] },
                                  properties: { heading: state.heading } });
  trail.push([state.lon, state.lat]);
  if (trail.length > 600) trail.shift();
  map.getSource("trail").setData({ type: "Feature", geometry: { type: "LineString", coordinates: trail }, properties: {} });
}

map.on("click", (e) => {
  const to = { lat: e.lngLat.lat, lon: e.lngLat.lng };
  if (e.originalEvent.shiftKey) return walkTo([[to.lat, to.lon]]);
  stopWalk();
  state.heading = bearing(state, to);
  Object.assign(state, to, { speed: 0 });
  sendLocation(); drawUser();
});
map.on("click", "heroes-fill", (e) => {
  if (e.originalEvent.altKey && e.features[0]) send({ type: "ui", action: "tap_entity", entity_id: e.features[0].properties.id });
});
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    state.heading = (state.heading + (e.key === "ArrowLeft" ? -20 : 20) + 360) % 360;
    sendLocation(); drawUser();
  }
});

// ---------------------------------------------------------------- simulated walking

const R = 6371008.8, rad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const dl = rad(b.lat - a.lat), dn = rad(b.lon - a.lon);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function walkTo(points) {
  stopWalk();
  state.walk = { points: points.map(([lat, lon]) => ({ lat, lon })), i: 0 };
  $("pause").disabled = false;
  state.walk.timer = setInterval(stepWalk, 250);
}
function stopWalk() {
  if (state.walk) clearInterval(state.walk.timer);
  state.walk = null; state.speed = 0; $("pause").disabled = true; $("pause").textContent = "Pause"; state.paused = false;
}
let lastSent = 0;
function stepWalk() {
  const w = state.walk;
  if (!w || state.paused) return;
  const mult = Number($("speed").value);
  let step = 1.3 * 0.25 * mult; // metres per 250 ms tick
  while (step > 0 && w.i < w.points.length) {
    const target = w.points[w.i], d = dist(state, target);
    if (d <= step) { Object.assign(state, target); step -= d; w.i++; continue; }
    state.heading = bearing(state, target);
    const f = step / d;
    state.lat += (target.lat - state.lat) * f; state.lon += (target.lon - state.lon) * f; step = 0;
  }
  state.speed = 1.3; // report walking pace, not the sim multiplier, so the Director paces itself normally
  drawUser();
  if (Date.now() - lastSent > 1000 / Math.min(mult, 4)) sendLocation();
  if (w.i >= w.points.length) { stopWalk(); sendLocation(); }
}
$("demo").onclick = () => { Object.assign(state, { lat: DEMO_TRACK[0][0], lon: DEMO_TRACK[0][1] }); trail.length = 0;
                            map.easeTo({ center: [state.lon, state.lat] }); walkTo(DEMO_TRACK.slice(1)); };
$("pause").onclick = () => { state.paused = !state.paused; state.speed = state.paused ? 0 : 1.3;
                             $("pause").textContent = state.paused ? "Resume" : "Pause"; sendLocation(); };

// ---------------------------------------------------------------- session + audio

function send(msg) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg)); }
function sendLocation() {
  lastSent = Date.now();
  send({ type: "location", lat: state.lat, lon: state.lon, accuracy_m: 6, course_deg: state.heading,
         heading_deg: state.heading, speed_mps: state.speed, ts: Date.now(), source: "sim" });
}

$("start").onclick = async () => {
  if (state.ws) { state.ws.close(); return; }
  state.ctx = new AudioContext({ sampleRate: 24000 });
  await state.ctx.audioWorklet.addModule("audio-worklets.js");
  state.player = new AudioWorkletNode(state.ctx, "player");
  state.player.connect(state.ctx.destination);
  state.player.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "played") send({ type: "playback", item_id: state.hashToItem.get(m.key) || m.key, played_ms: m.ms,
                                    stopped: m.stopped });
  };
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/session`);
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.onopen = () => {
    send({ type: "hello", device_id: "debug-web", mode: "wander", ui_lang: navigator.language || "en",
           app_version: "debug-web", debug: true });
    sendLocation();
    $("start").textContent = "End session"; $("mic").disabled = false; $("quiet").disabled = false;
    log("dbg", "connected");
  };
  ws.onclose = () => {
    state.ws = null; setMic(false);
    $("start").textContent = "Start session"; $("mic").disabled = true; $("quiet").disabled = true;
    $("state").textContent = "offline"; $("state").classList.remove("live");
    log("dbg", "disconnected");
  };
  ws.onmessage = (e) => (typeof e.data === "string" ? onJson(JSON.parse(e.data)) : onAudio(e.data));
  setInterval(() => { if (!state.walk) sendLocation(); }, 2000); // keep the Director ticking while standing still
};

function onAudio(buf) {
  const key = [...new Uint8Array(buf, 0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  state.player.port.postMessage({ type: "chunk", key, pcm: buf.slice(12) }, []);
}

async function setMic(on) {
  if (on && !state.mic) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const src = state.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(state.ctx, "mic-capture");
    node.port.onmessage = (e) => { if (state.micOn && state.ws && state.ws.readyState === 1) state.ws.send(e.data); };
    src.connect(node);
    state.mic = { stream, node };
  }
  state.micOn = on;
  $("mic").textContent = on ? "Mic on" : "Mic off";
  $("mic").classList.toggle("on", on);
  if (state.ws) send({ type: "control", action: on ? "unmute_mic" : "mute_mic" });
}
$("mic").onclick = () => setMic(!state.micOn);
$("quiet").onclick = () => {
  const pausing = $("quiet").textContent === "Pause guide";
  send({ type: "control", action: pausing ? "pause_guide" : "resume_guide" });
  if (pausing) state.player.port.postMessage({ type: "flush" });
  $("quiet").textContent = pausing ? "Resume guide" : "Pause guide";
};
$("ask").onsubmit = (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text || !state.ws) return;
  state.player.port.postMessage({ type: "flush" });
  send({ type: "text", text });
  log("user", text);
  $("text").value = "";
};

// ---------------------------------------------------------------- downlink handling

async function sha1Hex8(s) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function onJson(m) {
  switch (m.type) {
    case "ready": log("dbg", `session ${m.session_id}, voice ${m.voice}`); break;
    case "state":
      $("state").textContent = m.guide_state.toLowerCase().replaceAll("_", " ");
      $("state").classList.toggle("live", ["NARRATING", "ANSWERING", "NAV_CUE"].includes(m.guide_state));
      $("lang").textContent = `${m.language} · ${m.proactivity}`;
      break;
    case "stop_playback": state.player.port.postMessage({ type: "flush" }); clearFocus(); break;
    case "transcript": onTranscript(m); break;
    case "map_focus": showFocus(m); break;
    case "card": showCard(m); break;
    case "route":
      map.getSource("route").setData(m.cleared ? empty : { type: "Feature", geometry: m.geojson, properties: {} });
      if (!m.cleared) log("dbg", `route: ${Math.round(m.eta_s / 60)} min, ${m.maneuvers.length} steps`);
      break;
    case "error": log("dbg", `ERROR ${m.code}: ${m.message}`); break;
    case "debug": onDebug(m); break;
  }
}

function onTranscript(m) {
  if (m.role === "assistant") sha1Hex8(m.item_id).then((h) => state.hashToItem.set(h, m.item_id));
  if (m.role === "user") return log("user", `🎙 ${m.text}`);
  let el = state.partial.get(m.item_id);
  if (!el) { el = log("assistant", ""); state.partial.set(m.item_id, el); }
  el.textContent = m.text;
  el.classList.toggle("partial", !m.final);
  if (m.final) state.partial.delete(m.item_id);
}

async function showFocus(m) {
  const feats = await Promise.all(m.entities.map(async (e) => {
    const f = polygonsAsRings(await (await fetch(`/v1/places/${e.entity_id}`)).json());
    f.properties.badge = e.badge || "";
    return f;
  }));
  map.getSource("focus").setData({ type: "FeatureCollection", features: feats });
  if (m.camera === "fit" && feats.length) {
    const b = new maplibregl.LngLatBounds([state.lon, state.lat], [state.lon, state.lat]);
    for (const f of feats) for (const c of flatCoords(f.geometry)) b.extend(c);
    map.fitBounds(b, { padding: 90, maxZoom: 17.5, duration: 600 });
  }
  clearTimeout(state.focusTimer);
  state.focusTimer = setTimeout(clearFocus, 45000);
}
function flatCoords(g) { return g.type === "Point" ? [g.coordinates] : g.coordinates.flat(g.type === "Polygon" ? 1 : 0); }
function clearFocus() { if (map.getSource("focus")) map.getSource("focus").setData(empty); }

function showCard(m) {
  const facts = m.facts.map((f) => {
    const src = f.source_url ? ` <a href="${encodeURI(f.source_url)}" target="_blank" rel="noopener">source</a>` :
      f.source_title ? ` <span>(${esc(f.source_title)})</span>` : "";
    return `<li>${esc(f.text)}${src}</li>`;
  }).join("");
  $("card").innerHTML = `<h2>${esc(m.title)}</h2><div class="sub">${esc(m.subtitle || "")}</div><ul>${facts}</ul>`;
  $("card").style.display = "block";
}

function onDebug(m) {
  const p = m.payload;
  if (m.kind === "attention_queue") {
    $("queue").textContent = "attention: " + (p.top.map((t) => `${t.name} ${t.side} ${t.d}m ${t.score}${t.introduced ? " ✓" : ""}`)
      .join(" · ") || "—") + `  [${p.state}]`;
  } else {
    log("dbg", `${m.kind}: ${JSON.stringify(p)}`);
  }
}

function log(kind, text) {
  const el = document.createElement("div");
  el.className = kind === "dbg" ? "dbg" : `msg ${kind}`;
  el.textContent = text;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
