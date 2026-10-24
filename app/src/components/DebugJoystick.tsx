import React, { useCallback, useEffect, useRef, useState } from "react";

const PAD = 112;
const KNOB = 44;
const DEADZONE = 0.14;
const MAX_SPEED_MPS = 7.2;

export interface DebugJoystickProps {
  headingDeg: number;
  speedMps: number;
  low?: boolean;
  onMove: (headingDeg: number, speedMps: number) => void;
  onRelease: () => void;
}

function vectorFromPointer(
  pad: HTMLDivElement,
  clientX: number,
  clientY: number
): { dx: number; dy: number; magnitude: number } {
  const rect = pad.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const radius = rect.width / 2 - KNOB / 2;
  const raw = Math.hypot(dx, dy);
  const clamped = Math.min(raw, radius);
  const scale = raw > 0 ? clamped / raw : 0;
  return {
    dx: dx * scale,
    dy: dy * scale,
    magnitude: radius > 0 ? clamped / radius : 0,
  };
}

export const DebugJoystick: React.FC<DebugJoystickProps> = ({
  headingDeg,
  speedMps,
  low = false,
  onMove,
  onRelease,
}) => {
  const padRef = useRef<HTMLDivElement>(null);
  const onReleaseRef = useRef(onRelease);
  onReleaseRef.current = onRelease;
  const [knob, setKnob] = useState({ x: 0, y: 0, active: false });

  useEffect(() => {
    return () => onReleaseRef.current();
  }, []);

  const applyPointer = useCallback(
    (clientX: number, clientY: number) => {
      const pad = padRef.current;
      if (!pad) return;
      const { dx, dy, magnitude } = vectorFromPointer(pad, clientX, clientY);
      setKnob({ x: dx, y: dy, active: true });
      if (magnitude < DEADZONE) {
        onMove(headingDeg, 0);
        return;
      }
      const travel = (magnitude - DEADZONE) / (1 - DEADZONE);
      const heading = (Math.atan2(dx, -dy) * 180) / Math.PI;
      onMove((heading + 360) % 360, travel * MAX_SPEED_MPS);
    },
    [headingDeg, onMove]
  );

  const endPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (padRef.current?.hasPointerCapture(event.pointerId)) {
        padRef.current.releasePointerCapture(event.pointerId);
      }
      setKnob({ x: 0, y: 0, active: false });
      onRelease();
    },
    [onRelease]
  );

  return (
    <div className={`wg-joystick${low ? " low" : ""}`} aria-label="Walk joystick">
      <div
        ref={padRef}
        className={`wg-joy-pad${knob.active ? " on" : ""}`}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={MAX_SPEED_MPS}
        aria-valuenow={Number(speedMps.toFixed(1))}
        aria-valuetext={
          knob.active
            ? `${Math.round(headingDeg)}° at ${speedMps.toFixed(1)} m/s`
            : "Release to stop"
        }
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          applyPointer(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          applyPointer(event.clientX, event.clientY);
        }}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <span className="wg-joy-n">N</span>
        <span
          className="wg-joy-knob"
          style={{
            transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`,
          }}
        />
      </div>
      <div className="wg-joy-meta">
        {knob.active
          ? `${Math.round(headingDeg)}° · ${speedMps.toFixed(1)} m/s`
          : "Drag to walk"}
      </div>
    </div>
  );
};
