/** 상태 화면의 캐릭터 시트 (core의 playerView, packages/mcp/src/statusServer.ts 가 보낸다) */
export type SymptomView = { id: string; label: string; penalty: number; tone: 1 | 2 | 3; fatal: boolean };

export type PlayerView = {
  name: string;
  genderLabel: string | null;
  portrait: string | null;
  /** 월드 팩 id: 초상화 그림 주소 (/portraits/<팩>/<id>.png) */
  packId?: string;
  /** 얼굴 고르기 기회 (12-139): 얼굴이 없으면 고를 수 있는 얼굴 (화풍 섹션). 없으면 null */
  portraitChoices?: { style: string; label: string; numbered?: boolean; faces: string[] }[] | null;
  age: number | null;
  roleLabel: string;
  occupationLabel: string | null;
  motive?: { label: string; summary: string } | null;
  scenario?: { title: string; pitch: string } | null;
  past?: { label: string; summary: string } | null;
  timeLabel: string;
  clock?: { time: string; hhmm?: string; minute?: number; segmentLabel?: string; date?: string | null; segment: string; season: string | null; weather: { label: string; icon: string | null; chill: number } | null; temperature?: { outside: number; feels: number; detail: string } | null };
  conditions: { id: string; label: string; levelLabel: string; worsened: boolean; icon?: string | null; step?: number; penalty?: number; fatal?: boolean }[];
  /** 보이는 증상 (12-74). tone: 1 노랑 · 2 주황 · 3 빨강 */
  symptoms?: SymptomView[];
  conditionPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  statRange?: { min: number; max: number };
  traits: { id: string; label: string; kind: TraitKind; description: string }[];
  /** 성격 축 (0이 아닌 것만) */
  persona?: { id: string; label: string; level: number; acting: string }[];
  /** 성격 표: 모든 축, 0 포함 */
  personaScale?: { id: string; low: string; high: string; value: number; acting: string }[];
  /** 설정 (4.6.4): 비밀은 사실과 아는 사람까지 */
  settings?: { id: string; slot: string; slotLabel: string; name: string; description: string; rolls: boolean; secret: { fact: string; knownBy: string[] } | null }[];
  /** 스킬 (4.2.1): usable false = 못 하는 전문 기술, tier 단계 이름, raiseCost 한 단계 올리는 점수 (못 함·최고 단계면 null) */
  skills: { id: string; label: string; category: string; kind: "common" | "expert"; value: number; usable: boolean; learned: number | null; tier: string; raiseCost: number | null; stats: string[] }[];
  growth: { level: number; xp: number; next: number; skillPoints: number; prev?: number; skillMax?: number; skillMin?: number; skillCosts?: number[] } | null;
  inventory: ItemView[];
  sceneItems: ItemView[];
  /** 창고 (12-149). label: 지금 넣을 수 있는 자리(사물함·거처)의 이름, canPut: 지금 넣을 수 있다, items: 이 구역에 맡겨 둔 것, home: 떠돌이의 거처(다른 구역일 때) */
  stash?: { label: string | null; canPut: boolean; items: ItemView[]; home: string | null } | null;
  present: {
    id: string;
    name: string;
    rankLabel: string;
    look: string;
    conditionLabel: string | null;
    states?: SymptomView[];
    note?: string | null;
    dead?: boolean;
    bond?: string | null;
  }[];
  service: { rankLabel?: string; merit: number; disobedience: number; daysServed: number; promotionMissing: string[] | null };
  mission: { title: string; briefing: string; deadlineLabel: string; deadlineLeftLabel?: string; urgent?: boolean; requirements: string[] } | null;
  faction: { name: string; about?: string; moraleLabel: string; rationLabel: string; plans?: string[]; war?: string[] } | null;
  zone: { name: string; owner: string } | null;
  /** 구역 안의 지금 장소 (12-244). 없으면 헤더는 구역 이름 */
  place?: { name: string; indoor: boolean; spawned: boolean } | null;
  battle: { title: string; sideLabel: string; round: string; momentum: number; momentumMax: number; momentumLabel: string; alarmLabel: string; positionLabel: string } | null;
  gear?: { weapon: GearView | null; armor: GearView[]; weight: number; capacity: number; burden: 0 | 1 | 2 } | null;
  companions?: { id: string; name: string; bondLabel: string; note: string | null; apart: boolean; states?: SymptomView[] }[];
  debts?: { name: string; amount: number }[];
  loan?: string[];
  /** 다짐 (12-164): 임무 칸 맨 아래 */
  resolve?: string | null;
  /** 할 일: 임무·부탁·약속·다짐 (core views/player.ts TodoView) */
  todos?: { key: string; kind: "임무" | "의뢰" | "약속" | "큰 이야기" | "다짐"; title: string; who: string | null; detail: string | null; dueLabel: string | null; urgent: boolean; steps: { text: string; met: boolean }[]; note: string | null }[];
  squad?: { id: string; name: string; doing: string; report: string | null; states?: SymptomView[] }[] | null;
  policy?: { label: string; option: string }[];
  ties?: { key: string; text: string }[];
  relations: { id: string; name: string; trust: number; affection: number; respect: number; dead?: boolean }[];
  /** 이름 툴팁: ?인물과 같은 정보 (core views/person.ts) */
  profiles?: Record<string, PersonProfile>;
  deeds: { id: string; summary: string; tagLabels: string[]; visibleWitnesses: string[] }[];
  beliefs: { id: string; fact: string; sourceLabel: string; learnedLabel: string }[];
  journal?: { key: string; timeLabel: string; scene: boolean; text: string }[];
  /** 메모 (12-75). 메모장과 펜·연필이 있을 때만 */
  memo?: { text: string } | null;
  map?: MapView | null;
  placeMap?: PlaceMapView | null;
};

export type GearView = { id: string; name: string; slot?: string; slotLabel: string; detail: string; durability?: { left: number; max: number } | null; ammo: string | null; icon?: string };

/** wear: 들거나 입을 수 있으면 그 자리 id */
export type ItemView = { id: string; name: string; quantity: number; icon?: string; wear?: string };

export type TraitKind = "positive" | "negative" | "personality";

/** 상태 화면의 새 게임 고르기 (core newGameView, 12-67) */
export type NewGameView = {
  mode: "new_world" | "heir";
  step: string;
  worlds?: { id: string; title: string; tagline: string; description: string }[];
  world?: { id?: string; title: string };
  /** 시나리오 고르기 (core scenarioChoices). locked: 잠겼으면 해금 조건 */
  scenarios?: { roleId: string; title: string; pitch: string; who: string; locked: string | null; goal: string | null }[];
  content?: { adultAge: number };
  character?: {
    index: { at: number; total: number };
    roleLabel: string;
    startSkills: { label: string; value: number }[];
    chosen: {
      past?: string | null;
      portrait?: string | null;
      name: string | null;
      gender: string | null;
      age?: number | null;
      abilities: { label: string; value: number }[];
      skills?: { label: string; value: number }[] | null;
      traits: string[] | null;
      persona?: string | null;
      settings?: string[] | null;
    };
    /** 캐릭터 설정 고르기 (4.6.4) */
    settings?: {
      slots: { id: string; label: string; max: number; hint: string; rolls: boolean }[];
      items: { id: string; slot: string; name: string; description: string; ok: boolean; reasons: string[]; clash: boolean; opposites: string[] }[];
    } | null;
    /** 과거 배경 (12-84) */
    pasts: { id: string; label: string; summary: string; skills: string; stats: string; items: string; minAge?: number | null }[];
    /** 자리(계급·직분)가 점수 없이 배운 상태로 주는 전문 기술 (4.2.1) */
    grantedSkills?: string;
    /** 고치기에서 점수를 둘 수 있는 전문 기술 id */
    teachable?: string[];
    pastDefaults: { stats: Record<string, number>; skills: Record<string, number> } | null;
    moves: { id: string; label: string; category: string; description: string; stats?: string; kind?: "common" | "expert" }[];
    /** 시작 스킬 점수와 단계마다 올리는 값 (costs[i]: min+i → +1) */
    skillRule: { points: number; min: number; max: number; costs: number[] } | null;
    options: { value: string; label: string; description?: string }[];
    /** 얼굴 고르기 (12-139): 고른 성별의 얼굴을 화풍 섹션으로. 비었으면 기본 실루엣 */
    /** numbered: 얼굴마다 번호를 보인다 */
    portraits?: { style: string; label: string; numbered?: boolean; faces: string[] }[];
    nameMax: number;
    age?: { min: number; max: number; default: number } | null;
    stats: { id: string; label: string; description: string }[];
    tiers: { value: number; count: number; label: string }[] | null;
    points: { total: number; cost: { value: number; cost: number }[]; maxLow: number } | null;
    traits: { id: string; label: string; kind: "positive" | "negative" | "personality"; cost: number; description: string; opposites: string[] }[];
    traitLimits: { max_positive: number; max_negative: number; max_personality?: number; max_phobia?: number } | null;
    unusedPoints: number;
    /** 성격 축 (12-99) */
    personaAxes?: { id: string; low: string; high: string; romance: boolean }[];
  };
};

/**
 * 만드는 중인 단계 (12-214). driver: 지금 누가 진행하는지 (화면 / 채팅), fromMenu: 메인 메뉴의 새로운 게임으로 열었다,
 * version: 초안의 판 (답과 함께 돌려보내 어긋남을 막는다)
 */
export type CreationStatus = { view: NewGameView; driver?: "screen" | "chat"; fromMenu?: boolean; version?: number };

/** 상태 화면을 기다리는 GM이 있는지 (12-214). 화면은 GM이 기다릴 때만 쓰는 리모컨이다 */
export type GmLink = { waiting: boolean };

/** 이어서 하기의 세이브 한 줄 (core world/slots.ts SaveSlot과 맞춘다) */
export type SaveSlot = {
  id: string;
  packId?: string;
  worldTitle: string;
  hero: {
    name: string;
    age: number | null;
    genderLabel: string | null;
    portrait: string | null;
    rankLabel: string;
    factionName: string;
    level: number;
    conditions: string[];
    zoneName: string | null;
    daysServed: number;
    generation: number;
    dead: boolean;
    ended: boolean;
  } | null;
  timeLabel: string | null;
  updatedAt: string;
  cheated: boolean;
  lockedBy: "web" | "mcp" | null;
};

/** 한 인물에 대해 플레이어가 아는 것 (?인물 이름과 같다) */
export type PersonProfile = {
  heading: string;
  rankLabel: string;
  age: number | null;
  look: string | null;
  reputation: string | null;
  traits: string[];
  attitude: { axis: string; label: string; word: string; value: number }[] | null;
  facts: { source: string; fact: string }[];
  /** 이 사람이 아는 내 비밀의 이름 (12-260) */
  knowsMySecret?: string | null;
};

/** 지도 (12-201) */
export type MapNode = { id: string; name: string; label: string; x: number; y: number; state: "here" | "visited" | "seen"; base: boolean; isolated: boolean; owner?: string | null; ownerNow?: boolean };
export type MapFaction = { id: string; name: string; color: number };
export type MapParty = { key: string; faction: string; label: string; force: string; zone: string; timeLabel: string };
export type MapView = { title?: string; nodes: MapNode[]; edges: [string, string][]; factions?: MapFaction[]; parties?: MapParty[] };
/** 구역 안 지도 (12-304) */
export type PlaceMapNode = { id: string; name: string; x: number; y: number; state: "here" | "known" | "door"; indoor: boolean; inside: boolean; roads: { name: string; known: boolean }[]; direction: string | null };
export type PlaceMapView = { zone: string; zoneName: string; nodes: PlaceMapNode[]; edges: [string, string][] };

/** 전황 지도 (디버그 전용, core debug/warView.ts). 진짜 전쟁 상태라 TRPG_DEBUG=1일 때만 온다 */
export type WarZoneView = { id: string; name: string; label: string; x: number; y: number; owner: string | null; base: boolean; isolated: boolean; fort: number; alerted: boolean; here: boolean };
export type WarPartyView = { id: string; faction: string; kind: string; label: string; size: number; zone: string; goal: string; task: string; returning: boolean; leader: string | null };
export type WarMapView = {
  time: number;
  factions: { id: string; name: string; color: number; combatants: number; population: number; morale: number; zones: number }[];
  zones: WarZoneView[];
  edges: [string, string][];
  parties: WarPartyView[];
  plans: { id: string; faction: string; label: string; target: string; filled: number; max: number }[];
  clashes: { zone: string; kind: string; attacker: string; defender: string | null; success: boolean; at: number }[];
};
