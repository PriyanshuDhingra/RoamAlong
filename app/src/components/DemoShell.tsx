import React, { useEffect, useRef, useState } from "react";

/**
 * Desktop showcase: the real app runs in a phone-sized iframe, and this panel walks a visitor
 * (e.g. a hackathon judge) through the best moments. Talks to the app with postMessage.
 */

interface AppState {
  connection: string;
  activity: string;
  mode: string;
  calibrated: boolean;
  stops: number;
  autoWalking: boolean;
  gps: boolean;
}

const PHONE_W = 390;
const PHONE_H = 844;
const BEZEL = 14;

const STEPS: { title: string; body: string; lines: string[] }[] = [
  {
    title: "Pick Tours at the top, then Start walk",
    body: "Allow the microphone. Oliver, your guide, says hello and asks what you're into. Talk over him any time; he stops and listens.",
    lines: [],
  },
  {
    title: "Tell him what you like",
    body: "He saves it and plans a walking tour around you, drawn on the map.",
    lines: ["I'm interested in architecture and history."],
  },
  {
    title: "Ask about what you see",
    body: "He looks places up live instead of guessing, and answers in whatever language you ask in.",
    lines: [
      "What's the Notre Place monument at Queen's Park?",
      "Tell me about the C. David Naylor Building.",
      "Parle-moi de la statue de Robert Raikes, s'il te plaît.",
    ],
  },
  {
    title: "Walk the tour",
    body: "Use Auto-walk below to follow the route, or your real location if you're out in Toronto. He speaks up as you pass landmarks.",
    lines: ["Sounds good, let's go!", "What's the next stop?"],
  },
  {
    title: "Take a detour",
    body: "Ask for anything nearby; he finds it and guides you there.",
    lines: ["I'm hungry. Find me an interesting breakfast place with good coffee."],
  },
];

export function DemoShell() {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [typed, setTyped] = useState("");
  const [scale, setScale] = useState(1);
  const appSrc = `/?app=1${window.location.search.replace(/^\?/, "&")}`;

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if (ev.data?.type === "ROAMALONG_STATE") setState(ev.data as AppState);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const fit = () =>
      setScale(Math.min(1, (window.innerHeight - 48) / (PHONE_H + BEZEL * 2)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const send = (action: string, extra: Record<string, unknown> = {}) =>
    frameRef.current?.contentWindow?.postMessage(
      { type: "ROAMALONG_DEMO", action, ...extra },
      window.location.origin
    );

  const say = (text: string) => send("say", { text });

  const status = !state
    ? "Loading…"
    : state.connection !== "open"
      ? "Not started"
      : state.activity === "speaking"
        ? "Oliver is speaking"
        : state.activity === "thinking" || state.activity === "searching"
          ? "Oliver is thinking"
          : "Listening";

  return (
    <div className="demo">
      <style>{CSS}</style>
      <div
        className="phone-slot"
        style={{ width: (PHONE_W + BEZEL * 2) * scale, height: (PHONE_H + BEZEL * 2) * scale }}
      >
        <div
          className="phone"
          style={{
            width: PHONE_W + BEZEL * 2,
            height: PHONE_H + BEZEL * 2,
            transform: `scale(${scale})`,
          }}
        >
          <iframe
            ref={frameRef}
            src={appSrc}
            title="RoamAlong"
            allow="microphone; geolocation; autoplay"
            style={{ width: PHONE_W, height: PHONE_H }}
          />
        </div>
      </div>

      <aside className="panel">
        <header>
          <img src="/assets/icon.png" alt="" className="logo" />
          <div>
            <h1>RoamAlong</h1>
            <p className="tag">A voice tour guide that walks Toronto with you.</p>
          </div>
        </header>

        <div className="status">
          <span className={`dot ${state?.connection === "open" ? "on" : ""}`} />
          {status}
          {state && state.stops > 0 && <span className="pill">{state.stops}-stop tour ready</span>}
        </div>

        <p className="hint">
          Speak to the phone, or click a line below to send it as if you said it.
        </p>

        <ol className="steps">
          {STEPS.map((step, i) => (
            <li key={step.title}>
              <div className="num">{i + 1}</div>
              <div>
                <h2>{step.title}</h2>
                <p>{step.body}</p>
                {i === 0 && (
                  <button className="primary" onClick={() => send("start")}>
                    Start walk
                  </button>
                )}
                {step.lines.map((line) => (
                  <button key={line} className="line" onClick={() => say(line)}>
                    “{line}”
                  </button>
                ))}
                {i === 3 && (
                  <div className="row">
                    <button className="primary" onClick={() => send("autowalk", { speed: 1.4 })}>
                      {state?.autoWalking ? "Stop walking" : "Auto-walk"}
                    </button>
                    <button onClick={() => send("autowalk", { speed: 4 })} disabled={state?.autoWalking}>
                      Fast-forward ×3
                    </button>
                    <button onClick={() => send(state?.gps ? "reset_location" : "gps")}>
                      {state?.gps ? "Back to Queen's Park" : "Use my location"}
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>

        <form
          className="type"
          onSubmit={(e) => {
            e.preventDefault();
            if (!typed.trim()) return;
            say(typed.trim());
            setTyped("");
          }}
        >
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Or type anything to Oliver…"
          />
          <button className="primary" type="submit">Send</button>
        </form>

        <footer>
          Built on Boson Higgs Realtime (voice), OpenStreetMap and Wikipedia, with live research by GPT-5 mini.
          Works best in Chrome or Safari with headphones.
        </footer>
      </aside>
    </div>
  );
}

const CSS = `
  :root { color-scheme: light; }
  body { margin: 0; }
  .demo {
    min-height: 100vh; display: flex; gap: 48px; align-items: flex-start; justify-content: center;
    padding: 24px; box-sizing: border-box;
    background: radial-gradient(1200px 600px at 20% 0%, #ccfbf1 0%, transparent 60%),
                radial-gradient(900px 600px at 100% 100%, #dbeafe 0%, transparent 60%), #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a;
  }
  .phone-slot { flex: none; position: sticky; top: 24px; align-self: flex-start; }
  .phone {
    position: absolute; top: 0; left: 0; box-sizing: border-box; padding: ${BEZEL}px; border-radius: 62px; background: #0f172a;
    box-shadow: 0 30px 80px rgba(15, 23, 42, 0.35), inset 0 0 0 2px #334155; transform-origin: top left;
  }
  .phone iframe { display: block; border: 0; border-radius: 48px; background: #fff; }
  .panel { width: 420px; max-width: 100%; display: flex; flex-direction: column; gap: 14px; }
  header { display: flex; gap: 14px; align-items: center; }
  .logo { width: 64px; height: 64px; border-radius: 16px; box-shadow: 0 6px 18px rgba(15, 118, 110, 0.35); }
  h1 { margin: 0; font-size: 30px; letter-spacing: -0.5px; }
  .tag { margin: 2px 0 0; color: #475569; }
  .status { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: #334155; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #cbd5e1; }
  .dot.on { background: #14b8a6; box-shadow: 0 0 0 4px rgba(20, 184, 166, 0.2); }
  .pill { margin-left: auto; padding: 3px 10px; border-radius: 999px; background: #ccfbf1; color: #0f766e; font-size: 12px; }
  .hint { margin: 0; font-size: 13px; color: #64748b; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
  .steps li { display: flex; gap: 12px; }
  .num { flex: none; width: 26px; height: 26px; border-radius: 50%; background: #0f766e; color: #fff;
         display: grid; place-items: center; font-size: 13px; font-weight: 700; }
  h2 { margin: 2px 0 4px; font-size: 15px; }
  .steps p { margin: 0 0 8px; font-size: 13px; line-height: 1.45; color: #475569; }
  button { font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 10px; border: 1px solid #cbd5e1;
           background: #fff; color: #0f172a; cursor: pointer; }
  button:hover:not(:disabled) { border-color: #14b8a6; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.primary { background: #0f766e; border-color: #0f766e; color: #fff; font-weight: 600; }
  button.line { display: block; text-align: left; margin: 0 0 6px; background: #f1f5f9; border-color: transparent; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  .type { display: flex; gap: 8px; }
  .type input { flex: 1; font: inherit; font-size: 14px; padding: 9px 12px; border-radius: 10px; border: 1px solid #cbd5e1; }
  footer { font-size: 12px; color: #94a3b8; line-height: 1.5; }
  @media (max-width: 900px) {
    .demo { flex-direction: column; align-items: center; gap: 24px; }
    .phone-slot { position: relative; top: 0; align-self: center; }
  }
`;
