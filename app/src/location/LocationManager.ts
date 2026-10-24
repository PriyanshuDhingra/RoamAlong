import type { GeoPoint } from "../../../shared/types.js";
import {
  bearingDegrees,
  haversineMeters,
  movePointByMeters,
} from "../../../shared/geo.js";

export interface LocationSnapshot {
  lat: number;
  lon: number;
  headingDeg: number;
  speedMps: number;
  source: "simulated" | "device_gps";
  timestamp: number;
}

export interface CityPreset {
  id: string;
  label: string;
  subtitle: string;
  lat: number;
  lon: number;
  headingDeg: number;
}

export const CURATED_CITY_PRESETS: CityPreset[] = [
  {
    id: "toronto_700_university",
    label: "700 University Ave, Toronto",
    subtitle: "Discovery District, Queen's Park, U of T & Kensington-Chinatown",
    lat: 43.6595,
    lon: -79.3912,
    headingDeg: 0,
  },
  {
    id: "soho_nyc",
    label: "SoHo Cast-Iron District, NYC",
    subtitle: "1857 Otis Elevator, Greene St Cast-Iron & Speakeasies",
    lat: 40.7244,
    lon: -74.0005,
    headingDeg: 18,
  },
  {
    id: "montmartre_paris",
    label: "Montmartre, Paris",
    subtitle: "Cobblestone Studios, Sacré-Cœur & Belle Époque Bistros",
    lat: 48.8867,
    lon: 2.3431,
    headingDeg: 90,
  },
  {
    id: "gion_kyoto",
    label: "Gion Machiya Quarter, Kyoto",
    subtitle: "Wooden Ochaya Teahouses, Shirakawa Canal & Shrines",
    lat: 35.0037,
    lon: 135.7756,
    headingDeg: 45,
  },
  {
    id: "trastevere_rome",
    label: "Trastevere, Rome",
    subtitle: "Medieval Piazzas, Roman Mosaics & Trattorias",
    lat: 41.8897,
    lon: 12.4701,
    headingDeg: 135,
  },
];

export class LocationManager {
  private snapshot: LocationSnapshot = {
    lat: CURATED_CITY_PRESETS[0].lat,
    lon: CURATED_CITY_PRESETS[0].lon,
    headingDeg: CURATED_CITY_PRESETS[0].headingDeg,
    speedMps: 0.9,
    source: "simulated",
    timestamp: Date.now(),
  };

  private listeners = new Set<(snap: LocationSnapshot) => void>();
  private watchId: number | null = null;
  private autoWalkTimer: ReturnType<typeof setInterval> | null = null;
  private autoWalkWaypoints: GeoPoint[] = [];
  private autoWalkIdx = 0;

  constructor() {
    this.setupExpoNativeBridgeListener();
  }

  /**
   * Listens for native GPS & compass heading updates streamed from the Expo Go shell (`App.tsx`)
   * via `react-native-webview` postMessage (`{ type: "EXPO_NATIVE_LOCATION", lat, lon, headingDeg, speedMps }`).
   */
  private setupExpoNativeBridgeListener(): void {
    if (typeof window === "undefined") return;

    const handleNativeMessage = (ev: Event) => {
      const raw = (ev as MessageEvent).data;
      if (typeof raw !== "string") return;
      try {
        const msg = JSON.parse(raw) as {
          type?: string;
          lat?: number;
          lon?: number;
          headingDeg?: number;
          speedMps?: number;
        };
        if (
          msg.type === "EXPO_NATIVE_LOCATION" &&
          typeof msg.lat === "number" &&
          typeof msg.lon === "number"
        ) {
          this.stopAutoWalk();
          this.snapshot = {
            lat: Number(msg.lat.toFixed(6)),
            lon: Number(msg.lon.toFixed(6)),
            headingDeg:
              typeof msg.headingDeg === "number" && !Number.isNaN(msg.headingDeg)
                ? ((Math.round(msg.headingDeg) % 360) + 360) % 360
                : this.snapshot.headingDeg,
            speedMps:
              typeof msg.speedMps === "number" && !Number.isNaN(msg.speedMps)
                ? Number(msg.speedMps.toFixed(2))
                : 0.8,
            source: "device_gps",
            timestamp: Date.now(),
          };
          this.emit();
        }
      } catch {
        // Ignore non-JSON postMessage frames
      }
    };

    window.addEventListener("message", handleNativeMessage);
    if (typeof document !== "undefined") {
      document.addEventListener("message", handleNativeMessage);
    }
  }

  getSnapshot(): LocationSnapshot {
    return { ...this.snapshot };
  }

  subscribe(listener: (snap: LocationSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Teleports immediately to a target coordinate (used by tap-on-map or city presets).
   */
  teleport(lat: number, lon: number, headingDeg?: number): void {
    this.stopAutoWalk();
    this.snapshot = {
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      headingDeg:
        typeof headingDeg === "number"
          ? ((headingDeg % 360) + 360) % 360
          : this.snapshot.headingDeg,
      speedMps: this.snapshot.speedMps,
      source: "simulated",
      timestamp: Date.now(),
    };
    this.emit();
  }

  /**
   * Steps the simulated walker in `headingDeg` by `stepMeters`.
   */
  stepDirection(headingDeg: number, stepMeters = 20): void {
    const nextPt = movePointByMeters(
      { lat: this.snapshot.lat, lon: this.snapshot.lon },
      headingDeg,
      stepMeters
    );
    this.snapshot = {
      lat: nextPt.lat,
      lon: nextPt.lon,
      headingDeg: ((headingDeg % 360) + 360) % 360,
      speedMps: Math.max(0.8, this.snapshot.speedMps),
      source: "simulated",
      timestamp: Date.now(),
    };
    this.emit();
  }

  /**
   * Moves the user a constant distance (`stepMeters`, default 20m) directly toward `target`
   * (used in Guided Tour Mode when pressing "Up" / ArrowUp).
   * Clamps to the exact destination coordinates if within one step so it never overshoots.
   */
  stepTowardDestination(
    target: GeoPoint,
    stepMeters = 20
  ): { distanceRemainingMeters: number; bearingDeg: number } {
    const current: GeoPoint = {
      lat: this.snapshot.lat,
      lon: this.snapshot.lon,
    };
    const dist = haversineMeters(current, target);
    const bearing = Math.round(bearingDegrees(current, target)) % 360;

    if (dist <= stepMeters) {
      this.snapshot = {
        lat: Number(target.lat.toFixed(6)),
        lon: Number(target.lon.toFixed(6)),
        headingDeg: bearing,
        speedMps: Math.max(1.0, this.snapshot.speedMps),
        source: "simulated",
        timestamp: Date.now(),
      };
      this.emit();
      return { distanceRemainingMeters: 0, bearingDeg: bearing };
    }

    const nextPt = movePointByMeters(current, bearing, stepMeters);
    const remaining = Math.round(haversineMeters(nextPt, target));
    this.snapshot = {
      lat: nextPt.lat,
      lon: nextPt.lon,
      headingDeg: bearing,
      speedMps: Math.max(1.0, this.snapshot.speedMps),
      source: "simulated",
      timestamp: Date.now(),
    };
    this.emit();
    return { distanceRemainingMeters: remaining, bearingDeg: bearing };
  }

  setHeading(headingDeg: number): void {
    this.snapshot = {
      ...this.snapshot,
      headingDeg: ((Math.round(headingDeg) % 360) + 360) % 360,
      timestamp: Date.now(),
    };
    this.emit();
  }

  setSpeed(speedMps: number): void {
    this.snapshot = {
      ...this.snapshot,
      speedMps: Number(Math.max(0, Math.min(5, speedMps)).toFixed(2)),
      timestamp: Date.now(),
    };
    this.emit();
  }

  /**
   * Starts continuous simulated walking either along a Guided Tour route or forward along current heading.
   */
  startAutoWalk(waypoints?: GeoPoint[]): void {
    this.stopAutoWalk();
    this.autoWalkWaypoints = waypoints && waypoints.length > 0 ? waypoints : [];
    this.autoWalkIdx = 0;
    if (this.snapshot.speedMps < 0.4) {
      this.snapshot.speedMps = 1.25;
    }

    this.autoWalkTimer = setInterval(() => {
      const speed = this.snapshot.speedMps || 1.2;
      if (this.autoWalkWaypoints.length > 0) {
        const target = this.autoWalkWaypoints[this.autoWalkIdx];
        if (!target) {
          this.stopAutoWalk();
          return;
        }
        const current: GeoPoint = {
          lat: this.snapshot.lat,
          lon: this.snapshot.lon,
        };
        const dist = haversineMeters(current, target);
        if (dist <= speed * 1.5) {
          this.autoWalkIdx =
            (this.autoWalkIdx + 1) % this.autoWalkWaypoints.length;
        }
        const nextTarget =
          this.autoWalkWaypoints[this.autoWalkIdx] ?? target;
        const bearing = bearingDegrees(current, nextTarget);
        const moved = movePointByMeters(current, bearing, speed);
        this.snapshot = {
          lat: moved.lat,
          lon: moved.lon,
          headingDeg: Math.round(bearing),
          speedMps: speed,
          source: "simulated",
          timestamp: Date.now(),
        };
        this.emit();
      } else {
        this.stepDirection(this.snapshot.headingDeg, speed * 1.2);
      }
    }, 1000);
  }

  stopAutoWalk(): void {
    if (this.autoWalkTimer) {
      clearInterval(this.autoWalkTimer);
      this.autoWalkTimer = null;
    }
  }

  isAutoWalking(): boolean {
    return this.autoWalkTimer !== null;
  }

  /**
   * Switches between simulated GPS and real device geolocation.
   */
  enableDeviceGps(enable: boolean): void {
    if (!enable) {
      if (
        this.watchId !== null &&
        typeof navigator !== "undefined" &&
        navigator.geolocation
      ) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      this.snapshot = {
        ...this.snapshot,
        source: "simulated",
        timestamp: Date.now(),
      };
      this.emit();
      return;
    }

    this.stopAutoWalk();
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          this.snapshot = {
            lat: Number(pos.coords.latitude.toFixed(6)),
            lon: Number(pos.coords.longitude.toFixed(6)),
            headingDeg:
              typeof pos.coords.heading === "number" &&
              !Number.isNaN(pos.coords.heading)
                ? Math.round(pos.coords.heading)
                : this.snapshot.headingDeg,
            speedMps:
              typeof pos.coords.speed === "number" &&
              !Number.isNaN(pos.coords.speed)
                ? Number(pos.coords.speed.toFixed(2))
                : 0.8,
            source: "device_gps",
            timestamp: Date.now(),
          };
          this.emit();
        },
        () => {
          this.snapshot = { ...this.snapshot, source: "simulated" };
          this.emit();
        },
        { enableHighAccuracy: true, maximumAge: 2000 }
      );
    }
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const cb of this.listeners) {
      cb(snap);
    }
  }
}
