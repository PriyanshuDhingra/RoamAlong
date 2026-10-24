import {
  DEFAULT_CALIBRATION_PROFILE,
  type UserCalibrationProfile,
} from "../../../shared/types.js";

const STORAGE_KEY = "handheld_boson_calibration_v4";

export function loadSavedCalibrationProfile(): UserCalibrationProfile {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<UserCalibrationProfile>;
        return {
          ...DEFAULT_CALIBRATION_PROFILE,
          ...parsed,
          // Each visit starts in Tours, uncalibrated: the guide asks what they like, then plans the route.
          calibrated: false,
          mode: "guided_tour",
        };
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return { ...DEFAULT_CALIBRATION_PROFILE, calibrated: false };
}

export function saveCalibrationProfileToStorage(
  profile: UserCalibrationProfile
): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    }
  } catch {
    // Ignore storage write errors
  }
}

export function clearCalibrationProfileStorage(): UserCalibrationProfile {
  const fresh: UserCalibrationProfile = {
    ...DEFAULT_CALIBRATION_PROFILE,
    calibrated: false,
    updatedAt: Date.now(),
  };
  saveCalibrationProfileToStorage(fresh);
  return fresh;
}
