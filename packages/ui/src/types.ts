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
  skills: { id: string; label: string; category: string; value: number; stats: string[] }[];
  growth: { level: number; xp: number; next: number; skillPoints: number; prev?: number; skillMax?: number } | null;
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
  faction: { name: string; about?: string; moraleLabel: string; rationLabel: string } | null;
  zone: { name: string; owner: string } | null;
  battle: { title: string; sideLabel: string; round: string; momentum: number; momentumMax: number; momentumLabel: string; alarmLabel: string; positionLabel: string } | null;
  gear?: { weapon: GearView | null; armor: GearView[]; weight: number; capacity: number; burden: 0 | 1 | 2 } | null;
  companions?: { id: string; name: string; bondLabel: string; note: string | null; apart: boolean; states?: SymptomView[] }[];
  debts?: { name: string; amount: number }[];
  loan?: string[];
  /** 다짐 (12-164): 임무 칸 맨 아래 */
  resolve?: string | null;
  /** 할 일: 임무·부탁·약속·다짐 (core views/player.ts TodoView) */
  todos?: { key: string; kind: "임무" | "부탁" | "약속" | "다짐"; title: string; who: string | null; detail: string | null; dueLabel: string | null; urgent: boolean; steps: { text: string; met: boolean }[]; note: string | null }[];
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
    };
    /** 과거 배경 (12-84) */
    pasts: { id: string; label: string; summary: string; skills: string; stats: string; items: string; minAge?: number | null }[];
    rankSkills?: string;
    pastDefaults: { stats: Record<string, number>; skills: Record<string, number> } | null;
    moves: { id: string; label: string; category: string; description: string; stats?: string }[];
    skillRule: { points: number; max: number } | null;
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

export type CreationStatus = { view: NewGameView };

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
};

/** 지도 (12-201) */
export type MapNode = { id: string; name: string; label: string; x: number; y: number; state: "here" | "visited" | "seen"; base: boolean; isolated: boolean };
export type MapView = { nodes: MapNode[]; edges: [string, string][] };
