import type { ToolDisplayEvent } from "@trpg/core";

/** 서버 API 응답 형태 (packages/server/src/session.ts 와 맞춘다) */
export type PlayerView = {
  name: string;
  genderLabel: string | null;
  portrait: string | null;
  age: number | null;
  roleLabel: string;
  timeLabel: string;
  conditions: { id: string; label: string; levelLabel: string; worsened: boolean }[];
  conditionPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  skills: { id: string; label: string; category: string; value: number }[];
  growth: { level: number; xp: number; next: number; skillPoints: number } | null;
  inventory: { id: string; name: string; quantity: number }[];
  sceneItems: { id: string; name: string; quantity: number }[];
  present: { id: string; name: string; rankLabel: string; look: string; conditionLabel: string | null }[];
  service: { merit: number; disobedience: number; daysServed: number; promotionMissing: string[] | null };
  mission: { title: string; briefing: string; deadlineLabel: string; requirements: string[] } | null;
  faction: { name: string; moraleLabel: string; rationLabel: string } | null;
  zone: { name: string; owner: string } | null;
  battle: { title: string; sideLabel: string; round: string; momentum: number; momentumMax: number; momentumLabel: string; alarmLabel: string; positionLabel: string } | null;
  relations: { id: string; name: string; trust: number; affection: number; respect: number }[];
  deeds: { id: string; summary: string; tagLabels: string[]; visibleWitnesses: string[] }[];
  beliefs: { id: string; fact: string; sourceLabel: string; learnedLabel: string }[];
};

export type TranscriptView =
  | { kind: "player"; text: string }
  | { kind: "gm"; text: string }
  | { kind: "note"; text: string }
  | { kind: "tool"; display: ToolDisplayEvent };

export type GameView = {
  worldId: string;
  scenarioName: string;
  /** 시작 장면 */
  opening: string;
  player: PlayerView;
  transcript: TranscriptView[];
  busy: boolean;
  succession: { chronicle: string; options: { id: string; label: string; detail: string }[] } | null;
};

/** 세이브 슬롯 (packages/core/src/world/slots.ts 의 SaveSlot + current) */
export type SaveSlotView = {
  id: string;
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
  } | null;
  timeLabel: string | null;
  updatedAt: string;
  lockedBy: "web" | "mcp" | null;
  current: boolean;
};

export type SlotsView = { scenarioName: string; slots: SaveSlotView[]; current: string | null };

/** 캐릭터 생성 규칙 (core CreationRules) */
export type CreationRulesView = {
  defaultName: string;
  points: number;
  cost: { value: number; cost: number }[];
  maxLow: number;
  genders: { id: string; label: string }[];
  abilities: { id: string; label: string; description: string }[];
  startSkills: { label: string; value: number }[];
};

export type CharacterChoiceView = { name: string; gender: string | null; abilities: Record<string, number> | null; portrait: string | null };
