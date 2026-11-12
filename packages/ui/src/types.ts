import type { ToolDisplayEvent } from "@trpg/core";

/** 서버 API 응답 형태 (packages/server/src/session.ts 와 맞춘다) */
export type PlayerView = {
  name: string;
  roleLabel: string;
  timeLabel: string;
  injury: string;
  injuryLabel: string;
  injuryPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  inventory: { id: string; name: string; quantity: number }[];
  sceneItems: { id: string; name: string; quantity: number }[];
  present: { id: string; name: string; rankLabel: string; look: string; injuryLabel: string }[];
  beliefs: { id: string; fact: string; sourceLabel: string; learnedLabel: string }[];
};

export type TranscriptView =
  | { kind: "player"; text: string }
  | { kind: "gm"; text: string }
  | { kind: "tool"; display: ToolDisplayEvent };

export type GameView = { player: PlayerView; transcript: TranscriptView[]; busy: boolean };
