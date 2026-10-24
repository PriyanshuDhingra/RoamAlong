import React, { useState } from "react";
import type {
  QuadrantSector,
  SpatialHeartbeatResponse,
  TourMode,
  TourRoute,
} from "../../../shared/types.js";
import { haversineMeters } from "../../../shared/geo.js";
import {
  CURATED_CITY_PRESETS,
  type LocationSnapshot,
} from "../location/LocationManager.js";

export interface DebugLocationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  location: LocationSnapshot;
  heartbeat: SpatialHeartbeatResponse | null;
  mode: TourMode;
  activeRoute: TourRoute | null;
  isAutoWalking: boolean;
  showQuadrantOverlay: boolean;
  onToggleQuadrantOverlay: () => void;
  onTeleport: (lat: number, lon: number, headingDeg?: number) => void;
  onStepDirection: (headingDeg: number, meters?: number) => void;
  onStepUpAction: () => void;
  onHeadingChange: (headingDeg: number) => void;
  onSpeedChange: (speedMps: number) => void;
  onToggleAutoWalk: () => void;
  onToggleDeviceGps: (enable: boolean) => void;
  apiBaseUrl: string;
}

const SECTORS: QuadrantSector[] = ["CENTER", "NORTH", "EAST", "SOUTH", "WEST"];

export const DebugLocationDrawer: React.FC<DebugLocationDrawerProps> = ({
  isOpen,
  onClose,
  location,
  heartbeat,
  mode,
  activeRoute,
  isAutoWalking,
  showQuadrantOverlay,
  onToggleQuadrantOverlay,
  onTeleport,
  onStepDirection,
  onStepUpAction,
  onHeadingChange,
  onSpeedChange,
  onToggleAutoWalk,
  onToggleDeviceGps,
  apiBaseUrl,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    { name: string; lat: number; lon: number }[]
  >([]);
  const [searching, setSearching] = useState(false);

  if (!isOpen) return null;

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(
        `${apiBaseUrl}/api/spatial/search?q=${encodeURIComponent(
          searchQuery.trim()
        )}`
      );
      if (res.ok) {
        const data = (await res.json()) as {
          results: { name: string; lat: number; lon: number }[];
        };
        setSearchResults(data.results ?? []);
      }
    } finally {
      setSearching(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 68,
        right: 16,
        width: 350,
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "calc(100vh - 96px)",
        overflowY: "auto",
        background: "rgba(15, 23, 42, 0.94)",
        backdropFilter: "blur(16px)",
        border: "1px solid rgba(148, 163, 184, 0.22)",
        borderRadius: 16,
        padding: 16,
        color: "#f8fafc",
        zIndex: 1200,
        boxShadow: "0 20px 40px rgba(0,0,0,0.55)",
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#38bdf8" }}>
            GPS Simulator & N/S/E/W Inspector
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>
            Tap anywhere on map to teleport or walk with D-pad
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "rgba(255,255,255,0.08)",
            border: "none",
            color: "#e2e8f0",
            borderRadius: 8,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>

      {/* Telemetry Row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          background: "rgba(30, 41, 59, 0.7)",
          padding: 10,
          borderRadius: 10,
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ color: "#94a3b8", fontSize: 11 }}>Coordinates</div>
          <div style={{ fontFamily: "monospace", fontWeight: 600 }}>
            {location.lat.toFixed(5)}, {location.lon.toFixed(5)}
          </div>
        </div>
        <div>
          <div style={{ color: "#94a3b8", fontSize: 11 }}>Tile / Heading</div>
          <div style={{ fontFamily: "monospace", fontWeight: 600 }}>
            {heartbeat?.tileKey ?? "loading"} · {location.headingDeg}°
          </div>
        </div>
      </div>

      {/* Virtual Walking D-Pad + Auto-Walk */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontWeight: 600,
            marginBottom: 6,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            {mode === "guided_tour" && activeRoute
              ? "Guided Step (Press ↑ Up Key = +20m to Stop)"
              : "Virtual Footsteps (20m step / Arrow Keys)"}
          </span>
          <label style={{ fontSize: 11, color: "#38bdf8", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={location.source === "device_gps"}
              onChange={(e) => onToggleDeviceGps(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            Real Device GPS
          </label>
        </div>

        {mode === "guided_tour" &&
          activeRoute &&
          activeRoute.stops[activeRoute.currentStopIndex] && (
            <div
              style={{
                background: "rgba(16, 185, 129, 0.14)",
                border: "1px solid rgba(16, 185, 129, 0.35)",
                borderRadius: 8,
                padding: "7px 10px",
                marginBottom: 8,
                fontSize: 11,
                color: "#a7f3d0",
              }}
            >
              <strong>
                Next Guided Stop #{activeRoute.currentStopIndex + 1}:
              </strong>{" "}
              {activeRoute.stops[activeRoute.currentStopIndex].poi.name} (
              {Math.round(
                haversineMeters(
                  location,
                  activeRoute.stops[activeRoute.currentStopIndex].poi
                )
              )}
              m away)
            </div>
          )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 6,
            marginBottom: 8,
          }}
        >
          <div />
          <button
            onClick={onStepUpAction}
            style={{
              ...dpadBtnStyle,
              borderColor:
                mode === "guided_tour" && activeRoute
                  ? "#10b981"
                  : "rgba(148, 163, 184, 0.25)",
              background:
                mode === "guided_tour" && activeRoute
                  ? "rgba(16, 185, 129, 0.25)"
                  : "rgba(30, 41, 59, 0.9)",
              fontWeight: mode === "guided_tour" && activeRoute ? 700 : 500,
            }}
          >
            {mode === "guided_tour" && activeRoute
              ? "▲ Step to Stop (↑)"
              : "▲ Walk N (↑)"}
          </button>
          <div />
          <button
            onClick={() => onStepDirection(270, 20)}
            style={dpadBtnStyle}
          >
            ◀ Walk W
          </button>
          <button
            onClick={onToggleAutoWalk}
            style={{
              ...dpadBtnStyle,
              background: isAutoWalking ? "#f59e0b" : "#0ea5e9",
              color: "#0f172a",
              fontWeight: 700,
            }}
          >
            {isAutoWalking ? "⏸ Pause" : "▶ Auto-Walk"}
          </button>
          <button
            onClick={() => onStepDirection(90, 20)}
            style={dpadBtnStyle}
          >
            Walk E ▶
          </button>
          <div />
          <button
            onClick={() => onStepDirection(180, 20)}
            style={dpadBtnStyle}
          >
            ▼ Walk S
          </button>
          <div />
        </div>

        {/* Heading & Speed Sliders */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>
              Compass Heading: {location.headingDeg}°
            </div>
            <input
              type="range"
              min={0}
              max={359}
              value={location.headingDeg}
              onChange={(e) => onHeadingChange(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>
              Walk Speed: {location.speedMps} m/s
            </div>
            <input
              type="range"
              min={0}
              max={4}
              step={0.2}
              value={location.speedMps}
              onChange={(e) => onSpeedChange(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
        </div>
      </div>

      {/* Curated City Presets */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          Instant City Teleports
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {CURATED_CITY_PRESETS.map((city) => (
            <button
              key={city.id}
              onClick={() => onTeleport(city.lat, city.lon, city.headingDeg)}
              style={{
                textAlign: "left",
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(30, 41, 59, 0.85)",
                border: "1px solid rgba(148, 163, 184, 0.18)",
                color: "#f1f5f9",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 12 }}>{city.label}</div>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>
                {city.subtitle}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Custom Nominatim Place Search */}
      <form onSubmit={handleSearch} style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          Teleport Anywhere (OpenStreetMap Search)
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="e.g. Covent Garden London..."
            style={{
              flex: 1,
              background: "rgba(15, 23, 42, 0.9)",
              border: "1px solid rgba(148, 163, 184, 0.3)",
              borderRadius: 8,
              padding: "6px 10px",
              color: "#fff",
              fontSize: 12,
            }}
          />
          <button
            type="submit"
            disabled={searching}
            style={{
              background: "#38bdf8",
              color: "#0f172a",
              border: "none",
              borderRadius: 8,
              padding: "6px 12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {searching ? "..." : "Go"}
          </button>
        </div>
        {searchResults.length > 0 && (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
            {searchResults.map((r, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  onTeleport(r.lat, r.lon, 0);
                  setSearchResults([]);
                }}
                style={{
                  textAlign: "left",
                  fontSize: 11,
                  padding: "6px 8px",
                  background: "rgba(56, 189, 248, 0.12)",
                  border: "1px solid rgba(56, 189, 248, 0.3)",
                  color: "#e0f2fe",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                {r.name}
              </button>
            ))}
          </div>
        )}
      </form>

      {/* 4-Quadrant N/S/E/W Prefetch Cache Status */}
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <span style={{ fontWeight: 600 }}>4-Quadrant Research Agents</span>
          <label style={{ fontSize: 11, color: "#fbbf24", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showQuadrantOverlay}
              onChange={onToggleQuadrantOverlay}
              style={{ marginRight: 4 }}
            />
            Show Map Sectors
          </label>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {SECTORS.map((sec) => {
            const cache = heartbeat?.sectors[sec];
            return (
              <div
                key={sec}
                style={{
                  padding: "7px 10px",
                  borderRadius: 8,
                  background: "rgba(30, 41, 59, 0.65)",
                  border: "1px solid rgba(148, 163, 184, 0.15)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  <span style={{ color: "#38bdf8" }}>{sec} AGENT</span>
                  <span style={{ color: "#10b981" }}>
                    {cache
                      ? `${cache.stories.length} stories · ${cache.latencyMs}ms`
                      : "prefetching..."}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#cbd5e1",
                    marginTop: 2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {cache?.stories
                    .map((s) => s.name)
                    .slice(0, 2)
                    .join(" · ") || "Scanning OpenStreetMap..."}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const dpadBtnStyle: React.CSSProperties = {
  background: "rgba(30, 41, 59, 0.9)",
  border: "1px solid rgba(148, 163, 184, 0.25)",
  color: "#f8fafc",
  borderRadius: 8,
  padding: "7px 6px",
  fontSize: 11,
  cursor: "pointer",
};
