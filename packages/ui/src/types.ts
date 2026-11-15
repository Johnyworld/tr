/** 상태 화면의 캐릭터 시트 (core의 playerView, packages/mcp/src/statusServer.ts 가 보낸다) */
export type SymptomView = { id: string; label: string; penalty: number; tone: 1 | 2 | 3; fatal: boolean };

export type PlayerView = {
  name: string;
  genderLabel: string | null;
  portrait: string | null;
  age: number | null;
  roleLabel: string;
  occupationLabel: string | null;
  motive?: { label: string; summary: string } | null;
  timeLabel: string;
  clock?: { time: string; hhmm?: string; minute?: number; segmentLabel?: string; date?: string | null; segment: string; season: string | null; weather: { label: string; icon: string | null; chill: number } | null };
  conditions: { id: string; label: string; levelLabel: string; worsened: boolean; icon?: string | null; step?: number; penalty?: number; fatal?: boolean }[];
  /** 보이는 증상 (12-74). tone: 1 노랑 · 2 주황 · 3 빨강 */
  symptoms?: SymptomView[];
  conditionPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  statRange?: { min: number; max: number };
  traits: { id: string; label: string; kind: TraitKind; description: string }[];
  skills: { id: string; label: string; category: string; value: number }[];
  growth: { level: number; xp: number; next: number; skillPoints: number; prev?: number } | null;
  inventory: ItemView[];
  sceneItems: ItemView[];
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
};

export type GearView = { id: string; name: string; slotLabel: string; detail: string; durability?: { left: number; max: number } | null; ammo: string | null; icon?: string };

export type ItemView = { id: string; name: string; quantity: number; icon?: string };

export type TraitKind = "positive" | "negative" | "personality";

/** 상태 화면의 새 게임 고르기 (core newGameView, 12-67) */
export type NewGameView = {
  mode: "new_world" | "heir";
  step: string;
  worlds?: { id: string; title: string; tagline: string; description: string }[];
  world?: { title: string };
  /** 시나리오 고르기 (core scenarioChoices). locked: 잠겼으면 해금 조건 */
  scenarios?: { roleId: string; title: string; pitch: string; who: string; locked: string | null; goal: string | null }[];
  content?: { adultAge: number };
  character?: {
    index: { at: number; total: number };
    roleLabel: string;
    situation: string | null;
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
    };
    /** 과거 배경 (12-84) */
    pasts: { id: string; label: string; summary: string; skills: string; stats: string; items: string; minAge?: number | null }[];
    rankSkills?: string;
    pastDefaults: { stats: Record<string, number>; skills: Record<string, number> } | null;
    moves: { id: string; label: string; category: string; description: string }[];
    skillRule: { points: number; max: number } | null;
    options: { value: string; label: string; description?: string }[];
    nameMax: number;
    age?: { min: number; max: number; default: number } | null;
    stats: { id: string; label: string; description: string }[];
    tiers: { value: number; count: number; label: string }[] | null;
    points: { total: number; cost: { value: number; cost: number }[]; maxLow: number } | null;
    traits: { id: string; label: string; kind: "positive" | "negative" | "personality"; cost: number; description: string; opposites: string[] }[];
    traitLimits: { max_positive: number; max_negative: number; max_personality: number } | null;
    unusedPoints: number;
  };
};

export type CreationStatus = { view: NewGameView };

/** 한 인물에 대해 플레이어가 아는 것 (?인물 이름과 같다) */
export type PersonProfile = {
  heading: string;
  rankLabel: string;
  look: string | null;
  reputation: string | null;
  traits: string[];
  attitude: { axis: string; label: string; word: string; value: number }[] | null;
  facts: { source: string; fact: string }[];
};
