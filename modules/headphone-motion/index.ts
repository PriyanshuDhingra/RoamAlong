import { requireOptionalNativeModule } from "expo-modules-core";

export interface HeadphoneMotionSample {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export type HeadphoneMotionStatus =
  | "started"
  | "module_missing"
  | "unsupported"
  | "start_failed";

interface NativeHeadphoneMotionModule {
  isAvailable(): boolean;
  start(): boolean;
  stop(): void;
  addListener(
    event: "onHeadphoneMotion",
    listener: (sample: HeadphoneMotionSample) => void
  ): { remove(): void };
}

const nativeModule =
  requireOptionalNativeModule<NativeHeadphoneMotionModule>("HeadphoneMotion");

export function startHeadphoneMotion(
  onSample: (sample: HeadphoneMotionSample) => void
): { status: HeadphoneMotionStatus; stop: () => void; error?: string } {
  if (!nativeModule) {
    return { status: "module_missing", stop: () => {} };
  }
  if (!nativeModule.isAvailable()) {
    return { status: "unsupported", stop: () => {} };
  }
  try {
    const sub = nativeModule.addListener("onHeadphoneMotion", onSample);
    if (!nativeModule.start()) {
      sub.remove();
      return { status: "start_failed", stop: () => {} };
    }
    return {
      status: "started",
      stop: () => {
        sub.remove();
        nativeModule.stop();
      },
    };
  } catch (err) {
    return {
      status: "start_failed",
      stop: () => {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
