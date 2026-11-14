/** 상태 화면의 캐릭터 시트 (core의 playerView, packages/mcp/src/statusServer.ts 가 보낸다) */
export type PlayerView = {
  name: string;
  genderLabel: string | null;
  portrait: string | null;
  age: number | null;
  roleLabel: string;
  occupationLabel: string | null;
  timeLabel: string;
  clock?: { time: string; segment: string; season: string | null; weather: { label: string; icon: string | null; chill: number } | null };
  conditions: { id: string; label: string; levelLabel: string; worsened: boolean; icon?: string | null; step?: number; penalty?: number }[];
  conditionPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  statRange?: { min: number; max: number };
  traits: { id: string; label: string; kind: TraitKind; description: string }[];
  skills: { id: string; label: string; category: string; value: number }[];
  growth: { level: number; xp: number; next: number; skillPoints: number; prev?: number } | null;
  inventory: ItemView[];
  sceneItems: ItemView[];
  present: { id: string; name: string; rankLabel: string; look: string; conditionLabel: string | null }[];
  service: { merit: number; disobedience: number; daysServed: number; promotionMissing: string[] | null };
  mission: { title: string; briefing: string; deadlineLabel: string; deadlineLeftLabel?: string; urgent?: boolean; requirements: string[] } | null;
  faction: { name: string; moraleLabel: string; rationLabel: string } | null;
  zone: { name: string; owner: string } | null;
  battle: { title: string; sideLabel: string; round: string; momentum: number; momentumMax: number; momentumLabel: string; alarmLabel: string; positionLabel: string } | null;
  gear?: { weapon: GearView | null; armor: GearView[]; weight: number; capacity: number; burden: 0 | 1 | 2 } | null;
  companions?: { id: string; name: string; bondLabel: string; note: string | null; apart: boolean }[];
  debts?: { name: string; amount: number }[];
  loan?: string[];
  squad?: { id: string; name: string; doing: string; report: string | null }[] | null;
  policy?: { label: string; option: string }[];
  ties?: { key: string; text: string }[];
  relations: { id: string; name: string; trust: number; affection: number; respect: number; dead?: boolean }[];
  deeds: { id: string; summary: string; tagLabels: string[]; visibleWitnesses: string[] }[];
  beliefs: { id: string; fact: string; sourceLabel: string; learnedLabel: string }[];
  journal?: { key: string; timeLabel: string; scene: boolean; text: string }[];
};

export type GearView = { id: string; name: string; slotLabel: string; detail: string; durability?: { left: number; max: number } | null; ammo: string | null; icon?: string };

export type ItemView = { id: string; name: string; quantity: number; icon?: string };

export type TraitKind = "positive" | "negative" | "personality";

/** 상태 화면의 새 게임 고르기 (core newGameView, 12-67) */
export type NewGameView = {
  mode: "new_world" | "heir";
  step: string;
  worlds?: { id: string; title: string; tagline: string; description: string }[];
  premise?: string;
  world?: { title: string; intro: string };
  scenarios?: { id: string; title: string; pitch: string; custom: boolean }[];
  custom?: { maxLength: number; occupations: { label: string; summary: string }[]; story: string | null; result: string[] | null };
  content?: { adultAge: number };
  character?: {
    index: { at: number; total: number };
    roleLabel: string;
    situation: string | null;
    startSkills: { label: string; value: number }[];
    chosen: { name: string | null; gender: string | null; age?: number | null; abilities: { label: string; value: number }[]; traits: string[] | null };
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

export type CreationStatus = { view: NewGameView; gmWorking: boolean };
