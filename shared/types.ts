export type TourTopic =
  | "history"
  | "architecture"
  | "art"
  | "engineering"
  | "food"
  | "nature"
  | "music"
  | "trivia"
  | "news";

export type StoryStyle =
  | "deep_historical"
  | "witty_local_friend"
  | "architectural_detective"
  | "culinary_explorer";

export type TourMode = "wandering" | "guided_tour";

export type ProactivityLevel = "high" | "balanced" | "on_demand";

export type BosonVoicePreset =
  | "mia"
  | "chloe"
  | "marcus"
  | "jake"
  | "nora"
  | "eleanor"
  | "oliver"
  | "berlinda"
  | "default";

export interface UserCalibrationProfile {
  calibrated: boolean;
  topics: TourTopic[];
  story_style: StoryStyle;
  proactivity: ProactivityLevel;
  languages: string[];
  mode: TourMode;
  voice: BosonVoicePreset;
  updatedAt: number;
}

export const DEFAULT_CALIBRATION_PROFILE: UserCalibrationProfile = {
  calibrated: false,
  topics: ["history", "architecture", "food", "trivia"],
  story_style: "witty_local_friend",
  proactivity: "balanced",
  languages: ["English"],
  mode: "wandering",
  voice: "mia",
  updatedAt: Date.now(),
};

export type QuadrantSector = "CENTER" | "NORTH" | "SOUTH" | "EAST" | "WEST";

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface RawOsmPoi {
  osmId: string;
  osmType: "node" | "way" | "relation";
  name: string;
  lat: number;
  lon: number;
  category: TourTopic;
  tags: Record<string, string>;
  geometry?: GeoPoint[];
  wikipediaTag?: string;
  wikidataId?: string;
  distanceMeters?: number;
  bearingDeg?: number;
  sector?: QuadrantSector;
}

export interface StoryCard {
  id: string;
  osmId: string;
  name: string;
  lat: number;
  lon: number;
  sector: QuadrantSector;
  categories: TourTopic[];
  sensoryHook: string;
  narrativeSummary: string;
  hiddenTrivia: string;
  followUpQuestion: string;
  localLanguagePhrase?: {
    phrase: string;
    language: string;
    meaning: string;
  };
  geometry?: GeoPoint[];
  address?: string;
  wikipediaUrl?: string;
  score: number;
}

export interface DirectionalSectorCache {
  sector: QuadrantSector;
  tileKey: string;
  center: GeoPoint;
  stories: StoryCard[];
  status: "idle" | "researching" | "ready" | "error";
  synthesizedBy: "azure_openai";
  updatedAt: number;
  latencyMs: number;
}

export interface SpatialHeartbeatRequest {
  lat: number;
  lon: number;
  headingDeg: number;
  speedMps: number;
  profile: UserCalibrationProfile;
}

export interface SpatialHeartbeatResponse {
  tileKey: string;
  neighborhood: string;
  currentStreet: string;
  city: string;
  countryCode: string;
  headingDeg?: number;
  headingCardinal?: string;
  sectors: Record<QuadrantSector, DirectionalSectorCache>;
  recommendedImmediatePoi?: StoryCard;
  gazeCandidate?: {
    story: StoryCard;
    distanceMeters: number;
    angleOffGazeDeg: number;
    clockPosition: string;
  };
  directionHooks: {
    sector: QuadrantSector;
    relativeDirection: string;
    teaser: string;
    topPoiName: string;
  }[];
}

export interface MapHighlightAction {
  targetType: "building" | "street" | "neighborhood" | "direction_cone" | "route";
  osmId?: string;
  label: string;
  subtitle?: string;
  lat: number;
  lon: number;
  geometry?: GeoPoint[];
  radiusMeters?: number;
  bearingDeg?: number;
  category?: TourTopic;
  timestamp: number;
}

export interface TourStop {
  order: number;
  poi: StoryCard;
  arrivalRadiusMeters: number;
  visited: boolean;
  walkingBridgeStory: string;
}

export interface TourRoute {
  id: string;
  title: string;
  theme: string;
  mode: TourMode;
  stops: TourStop[];
  currentStopIndex: number;
  polyline: GeoPoint[];
  totalDistanceMeters: number;
  estimatedDurationMinutes: number;
  nextStepInstruction?: string;
}

export interface NavigationCue {
  mode: TourMode;
  currentStreet: string;
  neighborhood: string;
  targetName: string;
  distanceMeters: number;
  bearingDeg: number;
  clockPosition: string;
  relativeDirection: string;
  naturalWayfindingCue: string;
  offRoute: boolean;
}

export interface ToolResult<T = unknown> {
  summary: string;
  detail?: T;
  error?: string;
}
