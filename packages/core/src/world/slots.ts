import type { Content } from "../content/schemas.ts";
import { daysServed } from "../game/missions.ts";
import { formatTime } from "../rules/time.ts";
import { rankLabel, shownLevel } from "../scenario/scenario.ts";
import type { WorldInfo } from "./manager.ts";

/**
 * 세이브 슬롯 (시작 화면, MCP의 번호 목록). 두 모드가 같은 요약을 쓴다.
 * 세이브의 마지막 스냅숏에서 읽는다 (스키마 검증 없이). 숨은 단계는 캐릭터가 아는 단계로 보인다
 */
export type SaveSlot = {
  id: string;
  /** 월드 이름 (월드 팩의 world.title) */
  worldTitle: string;
  /** 주인공. 읽을 수 없는 세이브면 null */
  hero: {
    name: string;
    age: number | null;
    genderLabel: string | null;
    portrait: string | null;
    rankLabel: string;
    factionName: string;
    level: number;
    /** 처음 단계에서 나빠진 몸 상태만 (예: "부상 경상") */
    conditions: string[];
    zoneName: string | null;
    daysServed: number;
    /** 몇 번째 주인공인지 (이전 주인공이 죽고 이어 간 횟수 + 1) */
    generation: number;
    dead: boolean;
  } | null;
  timeLabel: string | null;
  updatedAt: string;
  /** 치트를 쓴 적이 있는 세이브 */
  cheated: boolean;
  /** 다른 곳에서 열려 있으면 어디서 (web/mcp) */
  lockedBy: "web" | "mcp" | null;
};

type RawState = {
  playerId?: string;
  time?: number;
  runStartedAt?: number;
  playerZone?: string | null;
  chronicle?: unknown[];
  cheated?: boolean;
  characters?: Record<string, { name?: string; age?: number; gender?: string | null; portrait?: string | null; rank?: string; factionId?: string; level?: number; dead?: boolean; conditions?: Record<string, string> }>;
};

export function toSaveSlot(info: WorldInfo, raw: unknown, content: Content): SaveSlot {
  const state = (raw ?? {}) as RawState;
  const s = content.scenario;
  const player = state.playerId ? state.characters?.[state.playerId] : undefined;
  const hero: SaveSlot["hero"] = player
    ? {
        name: player.name ?? "?",
        age: player.age ?? null,
        genderLabel: s.creation?.genders.find((g) => g.id === player.gender)?.label ?? null,
        portrait: player.portrait ?? null,
        rankLabel: player.rank ? rankLabel(s, player.rank) : "?",
        factionName: (player.factionId && content.factions[player.factionId]?.name) || "",
        level: player.level ?? 0,
        conditions: s.condition_tracks
          .map((t) => ({ track: t, shown: shownLevel(t, player.conditions?.[t.id]) }))
          .filter(({ track, shown }) => shown.id !== track.levels[0]!.id && !shown.fatal)
          .map(({ track, shown }) => `${track.label} ${shown.label}`),
        zoneName: state.playerZone ? (content.locations[state.playerZone]?.name ?? state.playerZone) : null,
        daysServed: typeof state.time === "number" ? daysServed(state.time, state.runStartedAt ?? state.time) + 1 : 1,
        generation: (state.chronicle?.length ?? 0) + (player.dead ? 0 : 1),
        dead: player.dead === true,
      }
    : null;
  return {
    id: info.id,
    worldTitle: content.scenario.world?.title ?? s.name,
    hero,
    timeLabel: typeof state.time === "number" ? formatTime(state.time) : null,
    updatedAt: info.updatedAt,
    cheated: state.cheated === true,
    lockedBy: info.lockedBy?.mode ?? null,
  };
}

/** 마지막 플레이 시각을 짧게 (예: "11월 12일 21:40") */
export function formatPlayedAt(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** MCP용 한 줄: "1. 신병 (23세) · 청솔형제단 하급 전투원 · 레벨 1 — 3일차 아침, 청솔형제단 거점 · 부상 경상 · 2대째 · 마지막 플레이 11월 12일 21:40" */
export function formatSlotLine(slot: SaveSlot, index: number): string {
  const h = slot.hero;
  if (!h) return `${index}. (읽을 수 없는 세이브) · ${slot.worldTitle} · 마지막 플레이 ${formatPlayedAt(slot.updatedAt)}`;
  const who = `${h.name}${h.age || h.genderLabel ? ` (${[h.genderLabel, h.age ? `${h.age}세` : null].filter(Boolean).join(", ")})` : ""} · ${[h.factionName, h.rankLabel].filter(Boolean).join(" ")} · 레벨 ${h.level}`;
  const where = [slot.timeLabel, h.zoneName].filter(Boolean).join(", ");
  const tags = [
    h.dead ? "사망 (다음 주인공을 고를 차례)" : h.conditions.length ? h.conditions.join(", ") : "몸 성함",
    `복무 ${h.daysServed}일째`,
    h.generation > 1 ? `${h.generation}대째` : null,
    slot.cheated ? "🛠 치트 사용" : null,
    slot.lockedBy ? "지금 다른 세션에서 사용 중" : null,
    `마지막 플레이 ${formatPlayedAt(slot.updatedAt)}`,
  ].filter(Boolean);
  return `${index}. ${who} — ${slot.worldTitle} · ${where} · ${tags.join(" · ")}`;
}
