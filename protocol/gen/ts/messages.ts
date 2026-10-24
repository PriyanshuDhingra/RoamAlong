/* Generated from protocol/messages.schema.json by protocol/generate.sh. Do not edit. */

/**
 * App -> Gateway
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "UplinkMessage".
 */
export type UplinkMessage = Hello | Location | Playback | Control | Ui;
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Mode".
 */
export type Mode = "wander" | "tour";
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "LocationSource".
 */
export type LocationSource = "gps" | "sim";
/**
 * Gateway -> App
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "DownlinkMessage".
 */
export type DownlinkMessage =
  Ready | StopPlayback | Transcript | MapFocus | Card | Route | NavCue | State | Debug | Error;
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "EntityKind".
 */
export type EntityKind =
  | "building"
  | "artwork"
  | "monument"
  | "park"
  | "tree"
  | "street"
  | "intersection"
  | "area"
  | "river"
  | "shoreline"
  | "venue"
  | "food"
  | "plaque"
  | "transit"
  | "other";
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "FocusStyle".
 */
export type FocusStyle = "building" | "area" | "street" | "point" | "path";
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "ClaimType".
 */
export type ClaimType = "established" | "contested" | "folklore";
/**
 * Conversation state machine (§7.0)
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "GuideState".
 */
export type GuideState =
  "LISTENING" | "ANSWERING" | "NARRATING" | "NAV_CUE" | "WAITING_FOR_USER" | "WAITING_FOR_DATA" | "IDLE" | "QUIET";
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Proactivity".
 */
export type Proactivity = "quiet" | "follow_my_lead" | "balanced" | "chatty";

/**
 * App <-> Gateway JSON text frames (IMPLEMENTATION_PLAN.md §3.4). Binary audio frames are described in protocol/README.md. Single source of truth: edit this file, then run protocol/generate.sh.
 */
export interface WanderProtocol {
  uplink?: UplinkMessage;
  downlink?: DownlinkMessage;
}
/**
 * First message on a new connection
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Hello".
 */
export interface Hello {
  type: "hello";
  device_id: string;
  user_id?: string;
  mode: Mode;
  tour_id?: string;
  /**
   * BCP 47, e.g. en, fr-CA
   */
  ui_lang: string;
  app_version: string;
  debug?: boolean;
  /**
   * Set when reconnecting to keep the Gateway session (§14.4)
   */
  resume_token?: string;
}
/**
 * 1 Hz, more often on large changes
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Location".
 */
export interface Location {
  type: "location";
  lat: number;
  lon: number;
  accuracy_m: number;
  /**
   * Device compass
   */
  heading_deg?: number;
  /**
   * Course over ground
   */
  course_deg?: number;
  speed_mps?: number;
  /**
   * Unix epoch milliseconds
   */
  ts: number;
  source: LocationSource;
}
/**
 * Every 250 ms while playing, and on local stop
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Playback".
 */
export interface Playback {
  type: "playback";
  item_id: string;
  played_ms: number;
  /**
   * True when playback of this item stopped locally (barge-in, cancel)
   */
  stopped?: boolean;
}
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Control".
 */
export interface Control {
  type: "control";
  /**
   * set_mode requires mode
   */
  action: "mute_mic" | "unmute_mic" | "pause_guide" | "resume_guide" | "ptt_down" | "ptt_up" | "set_mode";
  mode?: Mode;
}
/**
 * Taps become context for the guide
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Ui".
 */
export interface Ui {
  type: "ui";
  action: "tap_entity" | "tap_map" | "start_tour" | "stop_nav";
  entity_id?: string;
  lat?: number;
  lon?: number;
  tour_id?: string;
}
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Ready".
 */
export interface Ready {
  type: "ready";
  session_id: string;
  voice: string;
  mode: Mode;
  resume_token?: string;
}
/**
 * Flush the playback queue immediately
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "StopPlayback".
 */
export interface StopPlayback {
  type: "stop_playback";
  reason: "barge_in" | "cancel";
  /**
   * Items whose remaining audio must be dropped; empty = all
   */
  item_ids?: string[];
}
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Transcript".
 */
export interface Transcript {
  type: "transcript";
  role: "user" | "assistant";
  item_id: string;
  text: string;
  final: boolean;
  lang?: string;
}
/**
 * Highlight what is being talked about, synced to speech (§12.3)
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "MapFocus".
 */
export interface MapFocus {
  type: "map_focus";
  focus_id: string;
  response_id: string;
  /**
   * Audio item t_start_ms is relative to
   */
  item_id?: string;
  entities: FocusEntity[];
  style: FocusStyle;
  camera: "fit" | "keep";
  t_start_ms?: number;
}
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "FocusEntity".
 */
export interface FocusEntity {
  /**
   * Resolved DB id, never a spoken name
   */
  entity_id: string;
  kind: EntityKind;
  /**
   * Key of geometry already pushed to the app
   */
  geometry_ref?: string;
  label?: string;
  /**
   * A/B badge for ambiguity candidates
   */
  badge?: string;
}
/**
 * Bottom caption chip
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Card".
 */
export interface Card {
  type: "card";
  entity_id: string;
  title: string;
  subtitle?: string;
  thumb_url?: string;
  /**
   * @maxItems 5
   */
  facts:
    | []
    | [CardFact]
    | [CardFact, CardFact]
    | [CardFact, CardFact, CardFact]
    | [CardFact, CardFact, CardFact, CardFact]
    | [CardFact, CardFact, CardFact, CardFact, CardFact];
}
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "CardFact".
 */
export interface CardFact {
  text: string;
  claim_type?: ClaimType;
  source_title?: string;
  source_url?: string;
  /**
   * For time-bound items: freshness shown in the sheet
   */
  checked_at?: string;
  valid_until?: string;
}
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Route".
 */
export interface Route {
  type: "route";
  route_id: string;
  geojson: LineString;
  maneuvers: Maneuver[];
  eta_s: number;
  /**
   * True = navigation stopped, remove the route
   */
  cleared?: boolean;
}
/**
 * GeoJSON LineString, [lon, lat] order
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "LineString".
 */
export interface LineString {
  type: "LineString";
  /**
   * @minItems 2
   */
  coordinates: [
    [number, number] | [number, number, number],
    [number, number] | [number, number, number],
    ...([number, number] | [number, number, number])[]
  ];
}
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Maneuver".
 */
export interface Maneuver {
  index: number;
  instruction: string;
  lat: number;
  lon: number;
  /**
   * Length of the leg after this maneuver
   */
  distance_m: number;
  street_names?: string[];
  landmark_entity_id?: string;
}
/**
 * Haptic + earcon on the phone
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "NavCue".
 */
export interface NavCue {
  type: "nav_cue";
  maneuver_idx: number;
  distance_m: number;
  earcon: "turn_soon" | "turn_now" | "arrived" | "off_route";
}
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "State".
 */
export interface State {
  type: "state";
  mode: Mode;
  guide_state: GuideState;
  language: string;
  proactivity: Proactivity;
}
/**
 * Only sent when hello.debug=true
 *
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Debug".
 */
export interface Debug {
  type: "debug";
  /**
   * e.g. director_decision, attention_queue, event
   */
  kind: string;
  ts?: number;
  payload: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `WanderProtocol`'s JSON-Schema
 * via the `definition` "Error".
 */
export interface Error {
  type: "error";
  code: "auth" | "billing" | "upstream_busy" | "upstream_unavailable" | "bad_message" | "internal";
  message: string;
  fatal: boolean;
}
