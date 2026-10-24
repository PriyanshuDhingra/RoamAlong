import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  type GeoPoint,
  type MapHighlightAction,
  type SpatialHeartbeatResponse,
  type StoryCard,
  type TourMode,
  type TourRoute,
  type UserCalibrationProfile,
} from "../../shared/types.js";
import {
  BosonRealtimeClient,
  type ServerEvent,
  type TranscriptItem,
} from "./realtime/RealtimeClient.js";
import {
  LocationManager,
  type LocationSnapshot,
} from "./location/LocationManager.js";
import { ProactivityPacer } from "./location/ProactivityPacer.js";
import {
  loadSavedCalibrationProfile,
  saveCalibrationProfileToStorage,
} from "./location/calibrationStorage.js";
import { haversineMeters } from "../../shared/geo.js";
import { MinimalMap } from "./components/MinimalMap.js";
import { VoiceChrome } from "./components/VoiceChrome.js";

export const App: React.FC = () => {
  // Supports remote server URL when phone and backend are on different networks
  // via ?server=https://your-tunnel.trycloudflare.com or VITE_API_BASE_URL / EXPO_PUBLIC_API_URL
  const apiBaseUrl = useMemo(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const override = params.get("server");
      if (override) return override.replace(/\/+$/, "");
    }
    const envUrl =
      (import.meta as unknown as { env?: Record<string, string> }).env
        ?.VITE_API_BASE_URL || "";
    return envUrl.replace(/\/+$/, "");
  }, []);

  const locationManager = useMemo(() => new LocationManager(), []);
  const pacer = useMemo(() => new ProactivityPacer(), []);

  const [location, setLocation] = useState<LocationSnapshot>(() =>
    locationManager.getSnapshot()
  );
  const [profile, setProfileState] = useState<UserCalibrationProfile>(() =>
    loadSavedCalibrationProfile()
  );
  const [heartbeat, setHeartbeat] = useState<SpatialHeartbeatResponse | null>(
    null
  );
  const [activeRoute, setActiveRoute] = useState<TourRoute | null>(null);
  const [highlight, setHighlight] = useState<MapHighlightAction | null>(null);
  const [walkPath, setWalkPath] = useState<GeoPoint[] | null>(null);
  const [walkRouteError, setWalkRouteError] = useState<string | null>(null);
  const lastWalkFetchRef = useRef<{ key: string; from: GeoPoint } | null>(null);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [eventLogs, setEventLogs] = useState<ServerEvent[]>([]);
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [protocolDrawerOpen, setProtocolDrawerOpen] = useState(false);
  const [showQuadrantOverlay, setShowQuadrantOverlay] = useState(false);
  const [recenterToken, setRecenterToken] = useState(0);
  const [pacerStatus, setPacerStatus] = useState<string>(
    "Ready to read the room"
  );
  const [spatialError, setSpatialError] = useState<string | null>(null);
  const [, forceRender] = useState(0);

  // Refs for fresh state inside Boson tool callbacks
  const locationRef = useRef(location);
  locationRef.current = location;
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const heartbeatRef = useRef(heartbeat);
  heartbeatRef.current = heartbeat;
  const activeRouteRef = useRef(activeRoute);
  activeRouteRef.current = activeRoute;

  const setProfile = (next: UserCalibrationProfile) => {
    setProfileState(next);
    saveCalibrationProfileToStorage(next);
  };

  const rtClient = useMemo(
    () =>
      new BosonRealtimeClient(
        {
          apiBaseUrl,
          getLocation: () => locationRef.current,
          getProfile: () => profileRef.current,
          setProfile,
          getLatestHeartbeat: () => heartbeatRef.current,
          setLatestHeartbeat: (hb) => setHeartbeat(hb),
          getActiveRoute: () => activeRouteRef.current,
          setActiveRoute: (r) => setActiveRoute(r),
          onMapHighlight: (action) => setHighlight(action),
        },
        {
          onStateChange: () => forceRender((n) => n + 1),
          onEventLog: (ev) =>
            setEventLogs((prev) => [ev, ...prev.slice(0, 59)]),
          onTranscriptUpdate: (items) => setTranscript(items),
          onMicLevel: (rms) => setMicLevel(rms),
        }
      ),
    []
  );

  // Subscribe to LocationManager updates & auto-enable Real Device GPS on mobile phones/tablets
  useEffect(() => {
    const unsub = locationManager.subscribe((snap) => {
      setLocation(snap);
    });

    if (
      typeof navigator !== "undefined" &&
      /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    ) {
      locationManager.enableDeviceGps(true);
    }

    return unsub;
  }, [locationManager]);

  // Trigger 4-Quadrant (N/S/E/W) Spatial Heartbeat & Read-the-Room ProactivityPacer on location change
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/spatial/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: location.lat,
            lon: location.lon,
            headingDeg: location.headingDeg,
            speedMps: location.speedMps,
            profile: profileRef.current,
          }),
        });
        if (!res.ok) {
          const errJson = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(
            errJson.error || `Spatial heartbeat failed (HTTP ${res.status})`
          );
        }
        if (cancelled) return;
        const data = (await res.json()) as SpatialHeartbeatResponse;
        if (cancelled) return;
        setSpatialError(null);
        setHeartbeat(data);

        // Always keep the spotlight card synced with the closest immediate landmark as the user moves
        if (data.recommendedImmediatePoi) {
          const poi = data.recommendedImmediatePoi;
          setHighlight((prev) => {
            if (prev?.osmId === poi.osmId) return prev;
            return {
              targetType: "building",
              osmId: poi.osmId,
              label: poi.name,
              subtitle: poi.sensoryHook,
              lat: poi.lat,
              lon: poi.lon,
              geometry: poi.geometry,
              category: poi.categories[0],
              timestamp: Date.now(),
            };
          });
        }

        // Evaluate Read-the-Room ProactivityPacer
        const isGuideBusy =
          rtClient.activity === "speaking" ||
          rtClient.activity === "thinking" ||
          rtClient.activity === "searching";

        const decision = pacer.evaluate({
          location,
          heartbeat: data,
          profile: profileRef.current,
          activeRoute: activeRouteRef.current,
          isGuideBusy,
        });

        setPacerStatus(decision.reason);

        if (rtClient.state === "open") {
          if (decision.type === "passive_context_update") {
            rtClient.injectPassiveSpatialContext(decision.contextText);
          } else if (decision.type === "proactive_spoken_moment") {
            if (decision.poi) {
              setHighlight({
                targetType: "building",
                osmId: decision.poi.osmId,
                label: decision.poi.name,
                subtitle: decision.poi.sensoryHook,
                lat: decision.poi.lat,
                lon: decision.poi.lon,
                geometry: decision.poi.geometry,
                category: decision.poi.categories[0],
                timestamp: Date.now(),
              });
            }
            rtClient.triggerProactiveMoment(decision.promptText);
          }
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setSpatialError(msg);
          setPacerStatus(`Error: ${msg}`);
        }
      }
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    location.lat,
    location.lon,
    location.headingDeg,
    location.speedMps,
    profile.topics,
    profile.story_style,
    profile.mode,
  ]);

  // Street-following walking route to the next spot: the current guided stop, otherwise the spotlighted place
  const currentGuidedStop =
    profile.mode === "guided_tour" && activeRoute
      ? activeRoute.stops[activeRoute.currentStopIndex]?.poi ?? null
      : null;
  const navTarget: { key: string; lat: number; lon: number } | null =
    currentGuidedStop
      ? {
          key: `stop_${currentGuidedStop.osmId}`,
          lat: currentGuidedStop.lat,
          lon: currentGuidedStop.lon,
        }
      : highlight
      ? {
          key: `hl_${highlight.osmId ?? highlight.label}`,
          lat: highlight.lat,
          lon: highlight.lon,
        }
      : null;

  useEffect(() => {
    if (!navTarget) {
      lastWalkFetchRef.current = null;
      setWalkPath(null);
      setWalkRouteError(null);
      return;
    }

    const from: GeoPoint = { lat: location.lat, lon: location.lon };
    const last = lastWalkFetchRef.current;
    if (last && last.key === navTarget.key && haversineMeters(last.from, from) < 15) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      lastWalkFetchRef.current = { key: navTarget.key, from };
      try {
        const res = await fetch(`${apiBaseUrl}/api/navigation/walk-route`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromLat: from.lat,
            fromLon: from.lon,
            toLat: navTarget.lat,
            toLon: navTarget.lon,
          }),
        });
        const data = (await res.json()) as {
          polyline?: GeoPoint[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.polyline) {
          throw new Error(data.error || `Walking route failed (HTTP ${res.status})`);
        }
        setWalkPath(data.polyline);
        setWalkRouteError(null);
      } catch (err) {
        if (cancelled) return;
        lastWalkFetchRef.current = null;
        setWalkPath(null);
        setWalkRouteError(err instanceof Error ? err.message : String(err));
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [navTarget?.key, navTarget?.lat, navTarget?.lon, location.lat, location.lon]);

  const handleStartTour = async () => {
    if (rtClient.state !== "open") {
      await rtClient.connect();
    }
    try {
      await rtClient.startMicrophone();
      setMicActive(true);
    } catch {
      setMicActive(false);
    }
  };

  const handleToggleConnect = async () => {
    if (rtClient.state === "open" || rtClient.state === "connecting") {
      setMicActive(false);
      await rtClient.disconnect();
    } else {
      await rtClient.connect();
    }
  };

  const handleToggleMic = async () => {
    if (rtClient.state !== "open") {
      await rtClient.connect();
    }
    if (micActive) {
      rtClient.stopMicrophone();
      setMicActive(false);
      setMicLevel(0);
    } else {
      try {
        await rtClient.startMicrophone();
        setMicActive(true);
      } catch {
        setMicActive(false);
      }
    }
  };

  const handleSelectStoryOnMap = (story: StoryCard) => {
    setHighlight({
      targetType: "building",
      osmId: story.osmId,
      label: story.name,
      subtitle: story.sensoryHook,
      lat: story.lat,
      lon: story.lon,
      geometry: story.geometry,
      category: story.categories[0],
      timestamp: Date.now(),
    });
    pacer.markNarrated(story.osmId);

    if (rtClient.state === "open") {
      rtClient.sendUserText(
        `Tell me the story of ${story.name} right here—start with what I can see from the street.`,
        false,
        true
      );
    }
  };

  const handleSwitchMode = async (mode: TourMode) => {
    const nextProfile: UserCalibrationProfile = {
      ...profile,
      mode,
      updatedAt: Date.now(),
    };
    setProfile(nextProfile);

    if (mode === "wandering") {
      setActiveRoute(null);
      return;
    }

    const res = await fetch(`${apiBaseUrl}/api/tour/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: location.lat,
        lon: location.lon,
        headingDeg: location.headingDeg,
        profile: nextProfile,
        maxStops: 4,
      }),
    });
    if (res.ok) {
      const route = (await res.json()) as TourRoute;
      setActiveRoute(route);
      if (rtClient.state === "open") {
        rtClient.sendUserText(
          `I just switched to Guided Tour Mode for "${route.title}". Guide me to Stop 1 (${route.stops[0]?.poi.name})!`,
          false,
          true
        );
      }
    }
  };

  /**
   * Steps 20m toward the next Guided Tour destination when in Guided Tour Mode,
   * or 20m North when in Wandering Mode. Triggered by pressing the "▲" button or keyboard ArrowUp.
   */
  const handleStepUpOrGuided = () => {
    const route = activeRouteRef.current;
    const currentProfile = profileRef.current;

    if (
      currentProfile.mode === "guided_tour" &&
      route &&
      route.stops.length > 0
    ) {
      const targetStop =
        route.stops[route.currentStopIndex] ??
        route.stops.find((s) => !s.visited) ??
        route.stops[route.stops.length - 1];

      if (targetStop) {
        const { distanceRemainingMeters } =
          locationManager.stepTowardDestination(
            { lat: targetStop.poi.lat, lon: targetStop.poi.lon },
            20
          );

        // If we reached the exact stop (0m left) and there are more stops, advance the route pointer
        if (
          distanceRemainingMeters === 0 &&
          route.currentStopIndex < route.stops.length - 1
        ) {
          targetStop.visited = true;
          const updatedRoute: TourRoute = {
            ...route,
            currentStopIndex: route.currentStopIndex + 1,
          };
          setActiveRoute(updatedRoute);
        }
        return;
      }
    }

    locationManager.stepDirection(0, 20);
  };

  // Global keyboard arrow key listener (ArrowUp steps 20m toward next Guided Stop in Guided Mode)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        handleStepUpOrGuided();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        locationManager.stepDirection(180, 20);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        locationManager.stepDirection(270, 20);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        locationManager.stepDirection(90, 20);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [locationManager]);

  const latestAssistantLine = [...transcript]
    .reverse()
    .find((t) => t.role === "assistant");
  const latestSystemNotice = [...transcript]
    .reverse()
    .find((t) => t.role === "system");
  const showSystemNotice =
    latestSystemNotice &&
    (!latestAssistantLine ||
      latestSystemNotice.timestamp > latestAssistantLine.timestamp);

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        background: "#ffffff",
        color: "#222222",
      }}
    >
      {/* Full-Screen Minimalist Spotlight Map */}
      <MinimalMap
        location={location}
        heartbeat={heartbeat}
        highlight={highlight}
        activeRoute={activeRoute}
        walkPath={walkPath}
        showQuadrantOverlay={showQuadrantOverlay}
        recenterToken={recenterToken}
        onMapClickTeleport={(lat, lon) => {
          if (debugMode) locationManager.teleport(lat, lon);
        }}
        onSelectStory={handleSelectStoryOnMap}
      />

      <VoiceChrome
        connection={rtClient.state}
        activity={rtClient.activity}
        micActive={micActive}
        micLevel={micLevel}
        profile={profile}
        location={location}
        heartbeat={heartbeat}
        activeRoute={activeRoute}
        highlight={highlight}
        notice={spatialError || walkRouteError || (showSystemNotice ? latestSystemNotice?.text ?? null : null)}
        settingsOpen={settingsOpen}
        debugMode={debugMode}
        debugOpen={debugOpen}
        eventsOpen={protocolDrawerOpen}
        events={eventLogs}
        showQuadrantOverlay={showQuadrantOverlay}
        isAutoWalking={locationManager.isAutoWalking()}
        apiBaseUrl={apiBaseUrl}
        transcript={transcript}
        onOpenSettings={() => setSettingsOpen(true)}
        onCloseSettings={() => setSettingsOpen(false)}
        onStartTour={() => void handleStartTour()}
        onEndTour={() => void handleToggleConnect()}
        onToggleMic={() => void handleToggleMic()}
        onRecenter={() => setRecenterToken((token) => token + 1)}
        onSetMode={(mode) => void handleSwitchMode(mode)}
        onSetVoice={(voice) => {
          const next = { ...profileRef.current, voice, updatedAt: Date.now() };
          setProfile(next);
          if (rtClient.state === "open") rtClient.sendSessionUpdate();
        }}
        onToggleTopic={(topic) => {
          const current = profileRef.current;
          const topics = current.topics.includes(topic)
            ? current.topics.filter((item) => item !== topic)
            : [...current.topics, topic];
          setProfile({
            ...current,
            topics: topics.length > 0 ? topics : ["history"],
            updatedAt: Date.now(),
          });
        }}
        onToggleGps={() =>
          locationManager.enableDeviceGps(location.source !== "device_gps")
        }
        onToggleDebug={() => {
          setDebugMode((on) => !on);
          setDebugOpen(false);
          setProtocolDrawerOpen(false);
        }}
        onToggleSimulator={() => setDebugOpen((open) => !open)}
        onCloseDebug={() => setDebugOpen(false)}
        onToggleEvents={() => setProtocolDrawerOpen((open) => !open)}
        onToggleQuadrants={() => setShowQuadrantOverlay((on) => !on)}
        onTeleport={(lat, lon, heading) => locationManager.teleport(lat, lon, heading)}
        onStepDirection={(heading, meters) => locationManager.stepDirection(heading, meters)}
        onStepUp={handleStepUpOrGuided}
        onHeading={(deg) => locationManager.setHeading(deg)}
        onSpeed={(mps) => locationManager.setSpeed(mps)}
        onToggleAutoWalk={() => {
          if (locationManager.isAutoWalking()) locationManager.stopAutoWalk();
          else locationManager.startAutoWalk(activeRouteRef.current?.polyline);
          forceRender((n) => n + 1);
        }}
      />
    </div>
  );
};

