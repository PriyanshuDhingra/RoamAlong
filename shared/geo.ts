import type { GeoPoint, QuadrantSector } from "./types.js";

const EARTH_RADIUS_M = 6371000;

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(from: GeoPoint, to: GeoPoint): number {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lon - from.lon);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function classifySector(
  origin: GeoPoint,
  target: GeoPoint,
  centerRadiusMeters = 55
): { distanceMeters: number; bearingDeg: number; sector: QuadrantSector } {
  const distanceMeters = haversineMeters(origin, target);
  const bearingDeg = bearingDegrees(origin, target);

  if (distanceMeters <= centerRadiusMeters) {
    return { distanceMeters, bearingDeg, sector: "CENTER" };
  }

  if (bearingDeg >= 315 || bearingDeg < 45) {
    return { distanceMeters, bearingDeg, sector: "NORTH" };
  }
  if (bearingDeg >= 45 && bearingDeg < 135) {
    return { distanceMeters, bearingDeg, sector: "EAST" };
  }
  if (bearingDeg >= 135 && bearingDeg < 225) {
    return { distanceMeters, bearingDeg, sector: "SOUTH" };
  }
  return { distanceMeters, bearingDeg, sector: "WEST" };
}

export function cardinalFromHeading(headingDeg: number): string {
  const dirs = [
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
  ];
  const idx = Math.round((((headingDeg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx];
}

export function angularSpanOffHeading(
  origin: GeoPoint,
  headingDeg: number,
  target: GeoPoint,
  geometry?: GeoPoint[]
): { minAbsAngleDeg: number; signedAngleDeg: number } {
  const centerBearing = bearingDegrees(origin, target);
  const centerDiff = ((centerBearing - headingDeg + 540) % 360) - 180;
  if (!geometry || geometry.length < 3) {
    return { minAbsAngleDeg: Math.abs(centerDiff), signedAngleDeg: centerDiff };
  }

  let minDiff = centerDiff;
  let maxDiff = centerDiff;
  let bestAbs = Math.abs(centerDiff);
  let bestSigned = centerDiff;

  for (const pt of geometry) {
    const b = bearingDegrees(origin, pt);
    const diff = ((b - headingDeg + 540) % 360) - 180;
    if (diff < minDiff) minDiff = diff;
    if (diff > maxDiff) maxDiff = diff;
    if (Math.abs(diff) < bestAbs) {
      bestAbs = Math.abs(diff);
      bestSigned = diff;
    }
  }

  // If the building polygon straddles 0° (left vertex negative, right vertex positive) and isn't wrapping behind the user, the gaze ray hits the facade directly!
  if (minDiff <= 0 && maxDiff >= 0 && maxDiff - minDiff < 180) {
    return { minAbsAngleDeg: 0, signedAngleDeg: 0 };
  }
  return { minAbsAngleDeg: bestAbs, signedAngleDeg: bestSigned };
}

export function relativeClockAndDirection(
  userHeadingDeg: number,
  targetBearingDeg: number
): { clockPosition: string; relativeDirection: string; angleDiff: number } {
  const diff = ((targetBearingDeg - userHeadingDeg + 540) % 360) - 180;
  const normalized360 = (diff + 360) % 360;
  const rawHour = Math.round(normalized360 / 30) % 12;
  const hour = rawHour === 0 ? 12 : rawHour;
  const clockPosition = `${hour} o'clock`;

  let relativeDirection: string;
  if (Math.abs(diff) <= 22) {
    relativeDirection = "straight ahead";
  } else if (diff > 22 && diff <= 65) {
    relativeDirection = "slightly to your right";
  } else if (diff > 65 && diff <= 115) {
    relativeDirection = "on your right";
  } else if (diff > 115 && diff <= 155) {
    relativeDirection = "behind you to the right";
  } else if (diff < -22 && diff >= -65) {
    relativeDirection = "slightly to your left";
  } else if (diff < -65 && diff >= -115) {
    relativeDirection = "on your left";
  } else if (diff < -115 && diff >= -155) {
    relativeDirection = "behind you to the left";
  } else {
    relativeDirection = "directly behind you";
  }

  return { clockPosition, relativeDirection, angleDiff: diff };
}

/**
 * Deterministic spatial grid tile key (~150m x 150m cells).
 * 0.00135 degrees latitude is ~150 meters.
 */
export function snapToSpatialTile(point: GeoPoint): {
  tileKey: string;
  snappedCenter: GeoPoint;
  row: number;
  col: number;
} {
  const stepLat = 0.00135;
  const stepLon = 0.0017;
  const row = Math.round(point.lat / stepLat);
  const col = Math.round(point.lon / stepLon);
  return {
    tileKey: `tile_${row}_${col}`,
    snappedCenter: {
      lat: Number((row * stepLat).toFixed(6)),
      lon: Number((col * stepLon).toFixed(6)),
    },
    row,
    col,
  };
}

export function getSectorOffsetCenter(
  origin: GeoPoint,
  sector: QuadrantSector,
  offsetMeters = 140
): GeoPoint {
  if (sector === "CENTER") return origin;
  const dLat = offsetMeters / EARTH_RADIUS_M;
  const dLon = offsetMeters / (EARTH_RADIUS_M * Math.cos(toRad(origin.lat)));
  switch (sector) {
    case "NORTH":
      return { lat: origin.lat + toDeg(dLat), lon: origin.lon };
    case "SOUTH":
      return { lat: origin.lat - toDeg(dLat), lon: origin.lon };
    case "EAST":
      return { lat: origin.lat, lon: origin.lon + toDeg(dLon) };
    case "WEST":
      return { lat: origin.lat, lon: origin.lon - toDeg(dLon) };
  }
}

export function movePointByMeters(
  origin: GeoPoint,
  headingDeg: number,
  distanceMeters: number
): GeoPoint {
  const headingRad = toRad(headingDeg);
  const dNorth = distanceMeters * Math.cos(headingRad);
  const dEast = distanceMeters * Math.sin(headingRad);
  const dLat = toDeg(dNorth / EARTH_RADIUS_M);
  const dLon = toDeg(dEast / (EARTH_RADIUS_M * Math.cos(toRad(origin.lat))));
  return {
    lat: Number((origin.lat + dLat).toFixed(6)),
    lon: Number((origin.lon + dLon).toFixed(6)),
  };
}
