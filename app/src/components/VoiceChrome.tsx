import React, { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Building2,
  Map,
  Mic,
  MicOff,
  PersonStanding,
  Play,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { ServerEvent, TranscriptItem } from "../realtime/RealtimeClient.js";
import type { ConnectionState, GuideActivityState } from "../realtime/RealtimeClient.js";
import type {
  MapHighlightAction,
  SpatialHeartbeatResponse,
  TourMode,
  TourRoute,
  TourTopic,
  UserCalibrationProfile,
} from "../../../shared/types.js";
import type { LocationSnapshot } from "../location/LocationManager.js";
import { DebugLocationDrawer } from "./DebugLocationDrawer.js";
import { DebugJoystick } from "./DebugJoystick.js";

const TOPICS: TourTopic[] = [
  "history",
  "architecture",
  "food",
  "art",
  "engineering",
  "nature",
  "music",
  "trivia",
  "news",
];

const VOICES: { id: UserCalibrationProfile["voice"]; label: string }[] = [
  { id: "mia", label: "Mia" },
  { id: "chloe", label: "Chloe" },
  { id: "marcus", label: "Marcus" },
  { id: "jake", label: "Jake" },
  { id: "nora", label: "Nora" },
  { id: "eleanor", label: "Eleanor" },
  { id: "oliver", label: "Oliver" },
  { id: "berlinda", label: "Berlinda" },
  { id: "default", label: "Default" },
];

export interface VoiceChromeProps {
  connection: ConnectionState;
  activity: GuideActivityState;
  micActive: boolean;
  micLevel: number;
  profile: UserCalibrationProfile;
  location: LocationSnapshot;
  heartbeat: SpatialHeartbeatResponse | null;
  activeRoute: TourRoute | null;
  highlight: MapHighlightAction | null;
  notice: string | null;
  settingsOpen: boolean;
  debugMode: boolean;
  debugOpen: boolean;
  eventsOpen: boolean;
  events: ServerEvent[];
  showQuadrantOverlay: boolean;
  isAutoWalking: boolean;
  apiBaseUrl: string;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onStartTour: () => void;
  onEndTour: () => void;
  onToggleMic: () => void;
  onSetMode: (mode: TourMode) => void;
  onSetVoice: (voice: UserCalibrationProfile["voice"]) => void;
  onToggleTopic: (topic: TourTopic) => void;
  onToggleGps: () => void;
  onToggleDebug: () => void;
  onToggleSimulator: () => void;
  onCloseDebug: () => void;
  onToggleEvents: () => void;
  onToggleQuadrants: () => void;
  onTeleport: (lat: number, lon: number, headingDeg?: number) => void;
  onStepDirection: (headingDeg: number, meters?: number) => void;
  onStepUp: () => void;
  onHeading: (deg: number) => void;
  onSpeed: (mps: number) => void;
  onToggleAutoWalk: () => void;
  onAnalogMove: (headingDeg: number, speedMps: number) => void;
  onAnalogRelease: () => void;
  onSendChat: (text: string) => void;
  transcript: TranscriptItem[];
}

export const VoiceChrome: React.FC<VoiceChromeProps> = (props) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const grabStartRef = useRef<{ y: number } | null>(null);
  const suppressGrabClickRef = useRef(false);
  const [hiddenCard, setHiddenCard] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [chatDraft, setChatDraft] = useState("");
  const live = props.connection === "open";
  const connecting = props.connection === "connecting";
  const researching = props.activity === "searching";
  const speaking =
    props.activity === "speaking" || props.activity === "thinking";
  const lastLine = [...props.transcript].reverse().find((item) => item.role === "assistant");
  const guided = props.profile.mode === "guided_tour";
  const route = guided ? props.activeRoute : null;
  const stop = route?.stops[route.currentStopIndex];
  const cardKey = props.highlight
    ? `${props.highlight.label}:${props.highlight.lat.toFixed(5)}`
    : null;
  const showCard =
    props.highlight &&
    cardKey !== hiddenCard &&
    props.highlight.label !== stop?.poi.name;
  const dot =
    props.connection === "open" ? "#008A05" : connecting ? "#F5A623" : "#B0B0B0";
  const stateLabel = live
    ? researching
      ? "researching"
      : speaking
        ? "speaking"
        : props.micActive
          ? "listening"
          : "muted"
    : "offline";

  useEffect(() => {
    const el = captionRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lastLine?.text]);

  useEffect(() => {
    if (!props.settingsOpen) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onCloseSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.settingsOpen]);

  return (
    <>
      <div className="wg-top">
        <div className="wg-segment" role="tablist" aria-label="How you walk">
          <button
            type="button"
            className="wg-seg"
            role="tab"
            aria-selected={props.profile.mode === "wandering"}
            onClick={() => props.onSetMode("wandering")}
          >
            <PersonStanding size={15} strokeWidth={2.4} />
            Wander
          </button>
          <button
            type="button"
            className="wg-seg"
            role="tab"
            aria-selected={props.profile.mode === "guided_tour"}
            onClick={() => props.onSetMode("guided_tour")}
          >
            <Map size={15} strokeWidth={2.4} />
            Tours
          </button>
        </div>
        <button type="button" className="wg-circle" aria-label="Settings" onClick={props.onOpenSettings}>
          <SlidersHorizontal size={18} strokeWidth={2.2} />
          <span className="wg-dot" style={{ background: dot }} />
          {props.location.source === "simulated" ? <span className="wg-sim">SIM</span> : null}
        </button>
      </div>

      <div className={`wg-sheet${sheetOpen ? "" : " is-collapsed"}`}>
        <button
          type="button"
          className="wg-grabber-hit"
          aria-expanded={sheetOpen}
          aria-controls="wg-sheet-body"
          aria-label={sheetOpen ? "Collapse guide" : "Expand guide"}
          onPointerDown={(event) => {
            grabStartRef.current = { y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            const start = grabStartRef.current;
            grabStartRef.current = null;
            if (!start) return;
            const dy = event.clientY - start.y;
            if (dy > 28) {
              setSheetOpen(false);
              suppressGrabClickRef.current = true;
            } else if (dy < -28) {
              setSheetOpen(true);
              suppressGrabClickRef.current = true;
            }
          }}
          onClick={() => {
            if (suppressGrabClickRef.current) {
              suppressGrabClickRef.current = false;
              return;
            }
            setSheetOpen((open) => !open);
          }}
        >
          <span className="wg-grabber" />
        </button>
        <div
          id="wg-sheet-body"
          className="wg-sheet-body"
          inert={sheetOpen ? undefined : true}
          aria-hidden={sheetOpen ? undefined : true}
        >
          <div className="wg-sheet-inner">
        {props.notice ? (
          <p role="alert" className="wg-notice">
            {props.notice}
          </p>
        ) : null}

        {route && stop ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="wg-tour-head">
              <div style={{ flex: 1 }}>
                <div className="wg-kicker">{route.title}</div>
                <div className="wg-h2">
                  Stop {route.currentStopIndex + 1} of {route.stops.length}
                </div>
              </div>
              <div className="wg-eta">
                <div className="wg-eta-big">{route.estimatedDurationMinutes} min</div>
                <div className="wg-eta-small">{Math.round(route.totalDistanceMeters)} m</div>
              </div>
            </div>
            <div className="wg-dots">
              {route.stops.map((item, index) => (
                <span
                  key={item.poi.osmId}
                  className="wg-dotbar"
                  style={{
                    flex: index === route.currentStopIndex ? 2 : 1,
                    background: item.visited
                      ? "#111111"
                      : index === route.currentStopIndex
                        ? "#FF385C"
                        : "#EBEBEB",
                  }}
                />
              ))}
            </div>
            <div className="wg-stop-row">
              <div className="wg-photo" style={{ width: 44, height: 44, borderRadius: 10 }}>
                <Building2 size={18} strokeWidth={1.8} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="wg-stop-name">{stop.poi.name}</div>
                <div className="wg-stop-sub">
                  {stop.visited ? "Visited" : "Follow the line on the map"}
                </div>
              </div>
              <button type="button" className="wg-pill" onClick={props.onEndTour}>
                End
              </button>
            </div>
          </div>
        ) : null}

        {showCard && props.highlight ? (
          <div className="wg-place">
            <div className="wg-photo">
              <Building2 size={26} strokeWidth={1.6} />
            </div>
            <div className="wg-place-body">
              <div className="wg-place-title">{props.highlight.label}</div>
              {props.highlight.subtitle ? (
                <div className="wg-place-sub">{props.highlight.subtitle}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="wg-x"
              aria-label="Close card"
              onClick={() => setHiddenCard(cardKey)}
            >
              <X size={14} strokeWidth={2.4} />
            </button>
          </div>
        ) : null}

        {!live && !lastLine ? (
          <p className="wg-hint">
            Put your earbuds in and start a walk. Your guide will tell you about what you pass, and you can ask about anything.
          </p>
        ) : (
          <div className="wg-caption">
            <div className="wg-state">{stateLabel}</div>
            {lastLine ? (
              <p
                ref={captionRef}
                className="wg-caption-text"
                style={{ opacity: lastLine.status === "in_progress" ? 0.75 : 1 }}
              >
                {lastLine.text}
              </p>
            ) : null}
          </div>
        )}

        {props.debugMode ? (
          <form
            className="wg-chat"
            onSubmit={(event) => {
              event.preventDefault();
              const text = chatDraft.trim();
              if (!text || !live) return;
              props.onSendChat(text);
              setChatDraft("");
            }}
          >
            <input
              className="wg-chat-input"
              value={chatDraft}
              placeholder={live ? "Type to the guide" : "Start the guide to type"}
              disabled={!live}
              aria-label="Message the guide"
              onChange={(event) => setChatDraft(event.target.value)}
            />
            <button type="submit" className="wg-pill" disabled={!live || chatDraft.trim().length === 0}>
              Send
            </button>
          </form>
        ) : null}

        <div className="wg-controls">
          <TalkButton
            live={live}
            connecting={connecting}
            micOn={props.micActive}
            speaking={speaking || researching}
            researching={researching}
            onPress={() => (live ? props.onToggleMic() : props.onStartTour())}
          />
        </div>
          </div>
        </div>
      </div>

      {props.settingsOpen ? (
        <div className="wg-backdrop" onClick={props.onCloseSettings}>
          <div
            role="dialog"
            aria-label="Settings"
            className="wg-settings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="wg-grabber" />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h2 className="wg-settings-title">Settings</h2>
              <button ref={closeRef} type="button" className="wg-pill" onClick={props.onCloseSettings}>
                Close
              </button>
            </div>

            <div className="wg-label">Guide voice</div>
            <div className="wg-chips">
              {VOICES.map((voice) => (
                <button
                  key={voice.id}
                  type="button"
                  className={`wg-chip${(props.profile.voice || "mia") === voice.id ? " on" : ""}`}
                  onClick={() => props.onSetVoice(voice.id)}
                >
                  {voice.label}
                </button>
              ))}
            </div>

            <div className="wg-label">What to hear about</div>
            <div className="wg-chips">
              {TOPICS.map((topic) => (
                <button
                  key={topic}
                  type="button"
                  className={`wg-chip${props.profile.topics.includes(topic) ? " on" : ""}`}
                  onClick={() => props.onToggleTopic(topic)}
                >
                  {topic}
                </button>
              ))}
            </div>

            <div className="wg-label">Location</div>
            <div className="wg-chips">
              <button
                type="button"
                className={`wg-chip${props.location.source === "device_gps" ? " on" : ""}`}
                onClick={props.onToggleGps}
              >
                Real GPS
              </button>
            </div>
            <p className="wg-note">Status: {props.connection}.</p>

            <div className="wg-label">Debug tools</div>
            <button
              type="button"
              className={`wg-chip${props.debugMode ? " on" : ""}`}
              onClick={props.onToggleDebug}
            >
              {props.debugMode ? "Debug on" : "Debug off"}
            </button>

            {live ? (
              <button
                type="button"
                className="wg-chip on"
                style={{ display: "block", width: "100%", marginTop: 18, borderRadius: 12, padding: "11px 14px" }}
                onClick={props.onEndTour}
              >
                End tour
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {props.debugMode ? (
        <div className="wg-debug">
          <button type="button" className="wg-pill" onClick={props.onToggleSimulator}>
            {props.debugOpen ? "Hide simulator" : "GPS simulator"}
          </button>
          <button type="button" className="wg-pill" onClick={props.onToggleEvents}>
            Events ({props.events.length})
          </button>
        </div>
      ) : null}

      {props.debugMode && !props.eventsOpen ? (
        <HeadOrientationReadout location={props.location} />
      ) : null}

      {props.debugMode ? (
        <DebugJoystick
          headingDeg={props.location.headingDeg}
          speedMps={props.location.speedMps}
          low={!sheetOpen}
          onMove={props.onAnalogMove}
          onRelease={props.onAnalogRelease}
        />
      ) : null}

      {props.debugMode ? (
        <DebugLocationDrawer
          isOpen={props.debugOpen}
          onClose={props.onCloseDebug}
          location={props.location}
          heartbeat={props.heartbeat}
          mode={props.profile.mode}
          activeRoute={props.activeRoute}
          isAutoWalking={props.isAutoWalking}
          showQuadrantOverlay={props.showQuadrantOverlay}
          onToggleQuadrantOverlay={props.onToggleQuadrants}
          onTeleport={props.onTeleport}
          onStepDirection={props.onStepDirection}
          onStepUpAction={props.onStepUp}
          onHeadingChange={props.onHeading}
          onSpeedChange={props.onSpeed}
          onToggleAutoWalk={props.onToggleAutoWalk}
          onToggleDeviceGps={props.onToggleGps}
          apiBaseUrl={props.apiBaseUrl}
        />
      ) : null}

      {props.debugMode && props.eventsOpen ? (
        <div className="wg-log" role="log" aria-label="Realtime events">
          {props.events.length === 0
            ? "No events yet."
            : props.events.slice(0, 40).map((event, index) => (
                <div key={`${event.type}-${index}`}>{event.type}</div>
              ))}
        </div>
      ) : null}
    </>
  );
};

function describeHeadStatus(status?: string): string {
  if (!status) return "No status from the iPhone app (running in a browser?)";
  if (status === "module_missing") return "AirPods module is not in this build (Expo Go or old build)";
  if (status === "unsupported") return "This iPhone reports headphone motion unavailable";
  if (status === "started") return "Tracking started. Put in AirPods Pro, Max, 3 or 4";
  if (status === "not_started") return "Tracking has not started yet";
  return `Tracking failed: ${status}`;
}

function HeadOrientationReadout({ location }: { location: LocationSnapshot }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const ageMs = location.headUpdatedAt ? now - location.headUpdatedAt : null;
  const live = ageMs !== null && ageMs < 1500;
  const yaw = location.headYawDeg ?? 0;
  const pitch = location.headPitchDeg ?? 0;
  const roll = location.headRollDeg ?? 0;

  return (
    <div className="wg-log" aria-label="AirPods orientation">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <svg width="56" height="56" viewBox="-28 -28 56 56" aria-hidden="true">
          <circle r="26" fill="#F4F4F4" stroke="#EBEBEB" />
          <g transform={`rotate(${yaw})`}>
            <path d="M0 -22 L6 -8 L-6 -8 Z" fill={live ? "#FF385C" : "#B0B0B0"} />
            <line x1="0" y1="-8" x2="0" y2="10" stroke={live ? "#FF385C" : "#B0B0B0"} strokeWidth="2" />
          </g>
          <circle r="3" fill="#222" />
        </svg>
        <div style={{ fontVariantNumeric: "tabular-nums" }}>
          <div style={{ fontWeight: 700 }}>
            AirPods {live ? "live" : location.headUpdatedAt ? `stale ${Math.round((ageMs ?? 0) / 1000)}s` : "no data"}
          </div>
          {!live ? (
            <div style={{ color: "#6A6A6A" }}>{describeHeadStatus(location.headTrackingStatus)}</div>
          ) : null}
          <div>Yaw {yaw}°</div>
          <div>Pitch {pitch}°{pitch >= 15 ? " (looking up)" : pitch <= -15 ? " (looking down)" : ""}</div>
          <div>Roll {roll}°</div>
          <div>Gaze heading {location.headingDeg}°</div>
        </div>
      </div>
    </div>
  );
}

function TalkButton({
  live,
  connecting,
  micOn,
  speaking,
  researching,
  onPress,
}: {
  live: boolean;
  connecting: boolean;
  micOn: boolean;
  speaking: boolean;
  researching: boolean;
  onPress: () => void;
}) {
  const listening = live && micOn;
  const label = connecting
    ? "Connecting…"
    : !live
      ? "Start walk"
      : micOn
        ? researching
          ? "Researching"
          : speaking
            ? "Guide speaking"
            : "Listening"
        : "Tap to talk";
  const icon = !live ? (
    <Play size={30} fill="currentColor" strokeWidth={0} />
  ) : micOn ? (
    speaking ? (
      <AudioLines size={30} strokeWidth={2.2} />
    ) : (
      <Mic size={30} strokeWidth={2.2} />
    )
  ) : (
    <MicOff size={30} strokeWidth={2.2} />
  );
  return (
    <div className="wg-talk-wrap">
      <div className="wg-talk-box">
        {listening ? <span className="wg-talk-ring" /> : null}
        <button
          type="button"
          className={`wg-talk${live && !micOn ? " outlined" : ""}`}
          aria-label={label}
          disabled={connecting}
          onClick={onPress}
          style={{
            background: !live ? "#111111" : micOn ? "#FF385C" : "#FFFFFF",
            color: !live || micOn ? "#FFFFFF" : "#222222",
          }}
        >
          {icon}
        </button>
      </div>
      <span className="wg-talk-label">{label}</span>
    </div>
  );
}
