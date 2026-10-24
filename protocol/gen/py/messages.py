# Generated from protocol/messages.schema.json by protocol/generate.sh. Do not edit.

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class Mode(RootModel[Literal['wander', 'tour']]):
    root: Annotated[Literal['wander', 'tour'], Field(title='Mode')]


class GuideState(
    RootModel[
        Literal[
            'LISTENING',
            'ANSWERING',
            'NARRATING',
            'NAV_CUE',
            'WAITING_FOR_USER',
            'WAITING_FOR_DATA',
            'IDLE',
            'QUIET',
        ]
    ]
):
    root: Annotated[
        Literal[
            'LISTENING',
            'ANSWERING',
            'NARRATING',
            'NAV_CUE',
            'WAITING_FOR_USER',
            'WAITING_FOR_DATA',
            'IDLE',
            'QUIET',
        ],
        Field(description='Conversation state machine (§7.0)', title='GuideState'),
    ]


class Proactivity(RootModel[Literal['quiet', 'follow_my_lead', 'balanced', 'chatty']]):
    root: Annotated[
        Literal['quiet', 'follow_my_lead', 'balanced', 'chatty'],
        Field(title='Proactivity'),
    ]


class LocationSource(RootModel[Literal['gps', 'sim']]):
    root: Annotated[Literal['gps', 'sim'], Field(title='LocationSource')]


class EntityKind(
    RootModel[
        Literal[
            'building',
            'artwork',
            'monument',
            'park',
            'tree',
            'street',
            'intersection',
            'area',
            'river',
            'shoreline',
            'venue',
            'food',
            'plaque',
            'transit',
            'other',
        ]
    ]
):
    root: Annotated[
        Literal[
            'building',
            'artwork',
            'monument',
            'park',
            'tree',
            'street',
            'intersection',
            'area',
            'river',
            'shoreline',
            'venue',
            'food',
            'plaque',
            'transit',
            'other',
        ],
        Field(title='EntityKind'),
    ]


class FocusStyle(RootModel[Literal['building', 'area', 'street', 'point', 'path']]):
    root: Annotated[
        Literal['building', 'area', 'street', 'point', 'path'],
        Field(title='FocusStyle'),
    ]


class ClaimType(RootModel[Literal['established', 'contested', 'folklore']]):
    root: Annotated[
        Literal['established', 'contested', 'folklore'], Field(title='ClaimType')
    ]


class Coordinate(RootModel[list[float]]):
    root: Annotated[list[float], Field(max_length=3, min_length=2)]


class LineString(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['LineString']
    coordinates: Annotated[list[Coordinate], Field(min_length=2)]


class Hello(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['hello']
    device_id: str
    user_id: str | None = None
    mode: Mode
    tour_id: str | None = None
    ui_lang: Annotated[str, Field(description='BCP 47, e.g. en, fr-CA')]
    app_version: str
    debug: bool | None = False
    resume_token: Annotated[
        str | None,
        Field(description='Set when reconnecting to keep the Gateway session (§14.4)'),
    ] = None


class Location(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['location']
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]
    lon: Annotated[float, Field(ge=-180.0, le=180.0)]
    accuracy_m: Annotated[float, Field(ge=0.0)]
    heading_deg: Annotated[
        float | None, Field(description='Device compass', ge=0.0, le=360.0)
    ] = None
    course_deg: Annotated[
        float | None, Field(description='Course over ground', ge=0.0, le=360.0)
    ] = None
    speed_mps: Annotated[float | None, Field(ge=0.0)] = None
    ts: Annotated[float, Field(description='Unix epoch milliseconds')]
    source: LocationSource


class Playback(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['playback']
    item_id: str
    played_ms: Annotated[int, Field(ge=0)]
    stopped: Annotated[
        bool | None,
        Field(
            description='True when playback of this item stopped locally (barge-in, cancel)'
        ),
    ] = False


class Control(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['control']
    action: Annotated[
        Literal[
            'mute_mic',
            'unmute_mic',
            'pause_guide',
            'resume_guide',
            'ptt_down',
            'ptt_up',
            'set_mode',
        ],
        Field(description='set_mode requires mode'),
    ]
    mode: Mode | None = None


class Ui(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['ui']
    action: Literal[
        'tap_entity', 'tap_map', 'start_tour', 'stop_nav', 'end_tour', 'skip_stop'
    ]
    entity_id: str | None = None
    lat: float | None = None
    lon: float | None = None
    tour_id: str | None = None


class Text(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['text']
    text: Annotated[str, Field(max_length=2000, min_length=1)]


class Ready(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['ready']
    session_id: str
    voice: str
    mode: Mode
    resume_token: str | None = None


class StopPlayback(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['stop_playback']
    reason: Literal['barge_in', 'cancel']
    item_ids: Annotated[
        list[str] | None,
        Field(description='Items whose remaining audio must be dropped; empty = all'),
    ] = None


class Transcript(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['transcript']
    role: Literal['user', 'assistant']
    item_id: str
    text: str
    final: bool
    lang: str | None = None


class FocusEntity(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    entity_id: Annotated[str, Field(description='Resolved DB id, never a spoken name')]
    kind: EntityKind
    geometry_ref: Annotated[
        str | None, Field(description='Key of geometry already pushed to the app')
    ] = None
    label: str | None = None
    badge: Annotated[
        str | None, Field(description='A/B badge for ambiguity candidates')
    ] = None
    feature: Annotated[
        dict[str, Any] | None,
        Field(
            description='GeoJSON Feature for the entity, inline so the app needs no extra fetch'
        ),
    ] = None


class MapFocus(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['map_focus']
    focus_id: str
    response_id: str
    item_id: Annotated[
        str | None, Field(description='Audio item t_start_ms is relative to')
    ] = None
    entities: list[FocusEntity]
    style: FocusStyle
    camera: Literal['fit', 'keep']
    t_start_ms: Annotated[int | None, Field(ge=0)] = None


class CardFact(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    text: str
    claim_type: ClaimType | None = None
    source_title: str | None = None
    source_url: str | None = None
    checked_at: Annotated[
        AwareDatetime | None,
        Field(description='For time-bound items: freshness shown in the sheet'),
    ] = None
    valid_until: AwareDatetime | None = None


class Card(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['card']
    entity_id: str
    title: str
    subtitle: str | None = None
    thumb_url: str | None = None
    facts: Annotated[list[CardFact], Field(max_length=5)]


class Maneuver(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    index: Annotated[int, Field(ge=0)]
    instruction: str
    lat: float
    lon: float
    distance_m: Annotated[
        float, Field(description='Length of the leg after this maneuver')
    ]
    street_names: list[str] | None = None
    landmark_entity_id: str | None = None


class Route(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['route']
    route_id: str
    geojson: LineString
    maneuvers: list[Maneuver]
    eta_s: Annotated[float, Field(ge=0.0)]
    cleared: Annotated[
        bool | None, Field(description='True = navigation stopped, remove the route')
    ] = False


class NavCue(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['nav_cue']
    maneuver_idx: Annotated[int, Field(ge=0)]
    distance_m: Annotated[float, Field(ge=0.0)]
    earcon: Literal['turn_soon', 'turn_now', 'arrived', 'off_route']


class TourStop(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    entity_id: str
    name: str
    lat: float
    lon: float
    image_url: str | None = None
    summary: str | None = None
    status: Literal['done', 'current', 'upcoming']


class Tour(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['tour']
    tour_id: str
    title: str
    subtitle: str | None = None
    status: Literal['active', 'ended']
    current: Annotated[int, Field(ge=0)]
    stops: list[TourStop]
    leg_eta_min: int | None = None
    leg_distance_m: int | None = None


class State(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['state']
    mode: Mode
    guide_state: GuideState
    language: str
    proactivity: Proactivity


class Debug(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['debug']
    kind: Annotated[
        str, Field(description='e.g. director_decision, attention_queue, event')
    ]
    ts: float | None = None
    payload: dict[str, Any]


class Error(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: Literal['error']
    code: Literal[
        'auth',
        'billing',
        'upstream_busy',
        'upstream_unavailable',
        'bad_message',
        'internal',
    ]
    message: str
    fatal: bool


class UplinkMessage(RootModel[Hello | Location | Playback | Control | Ui | Text]):
    root: Annotated[
        Hello | Location | Playback | Control | Ui | Text,
        Field(description='App -> Gateway', title='UplinkMessage'),
    ]


class DownlinkMessage(
    RootModel[
        Ready
        | StopPlayback
        | Transcript
        | MapFocus
        | Card
        | Route
        | NavCue
        | State
        | Tour
        | Debug
        | Error
    ]
):
    root: Annotated[
        Ready
        | StopPlayback
        | Transcript
        | MapFocus
        | Card
        | Route
        | NavCue
        | State
        | Tour
        | Debug
        | Error,
        Field(description='Gateway -> App', title='DownlinkMessage'),
    ]


class WanderProtocol(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    uplink: UplinkMessage | None = None
    downlink: DownlinkMessage | None = None
