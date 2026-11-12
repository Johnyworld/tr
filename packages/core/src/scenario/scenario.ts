import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Character } from "../game/character.ts";
import { scenarioFileSchema, speechRulesSchema, type ConditionTrack, type Scenario } from "./schema.ts";

export class ScenarioError extends Error {
  override name = "ScenarioError";
}

/** 시나리오 폴더의 scenario.yaml과 연결된 화법·톤 파일을 읽는다 */
export function loadScenario(dir: string): Scenario {
  const read = (file: string) => {
    try {
      return readFileSync(join(dir, file), "utf8");
    } catch {
      throw new ScenarioError(`${file}을(를) 읽을 수 없다 (${dir})`);
    }
  };
  const file = scenarioFileSchema.safeParse(parse(read("scenario.yaml")));
  if (!file.success) throw new ScenarioError(`scenario.yaml: ${z.prettifyError(file.error)}`);
  const speech = speechRulesSchema.safeParse(parse(read(file.data.speech_rules)));
  if (!speech.success) throw new ScenarioError(`${file.data.speech_rules}: ${z.prettifyError(speech.error)}`);
  return {
    ...file.data,
    speech: speech.data,
    tone: read(file.data.gm_tone).trim(),
    rules: read(file.data.gm_rules).trim(),
    mcpGuide: read(file.data.mcp_guide).trim(),
    introText: file.data.intro ? read(file.data.intro).trim() : null,
  };
}

// ── 조회 도우미 ───────────────────────────────────────

export const statIds = (s: Scenario) => s.stats.map((x) => x.id);
export const moveIds = (s: Scenario) => s.moves.map((x) => x.id);
export const rankIds = (s: Scenario) => s.rank_ladder.map((x) => x.id);
export const trackIds = (s: Scenario) => s.condition_tracks.map((x) => x.id);

export const statLabel = (s: Scenario, id: string) => s.stats.find((x) => x.id === id)?.label ?? id;
export const moveOf = (s: Scenario, id: string) => s.moves.find((x) => x.id === id);
export const moveLabel = (s: Scenario, id: string) => moveOf(s, id)?.label ?? id;
export const rankOf = (s: Scenario, id: string) => s.rank_ladder.find((x) => x.id === id);
export const rankLabel = (s: Scenario, id: string) => rankOf(s, id)?.label ?? id;

export function trackOf(s: Scenario, id: string): ConditionTrack {
  const track = s.condition_tracks.find((t) => t.id === id);
  if (!track) throw new Error(`알 수 없는 상태 트랙: ${id}`);
  return track;
}

export const harmTrack = (s: Scenario) => trackOf(s, s.harm_track);

export function levelOf(track: ConditionTrack, levelId: string) {
  const level = track.levels.find((l) => l.id === levelId);
  if (!level) throw new Error(`알 수 없는 단계: ${track.id}.${levelId}`);
  return level;
}

/** 모든 상태 트랙의 첫 단계 */
export function initialConditions(s: Scenario): Record<string, string> {
  return Object.fromEntries(s.condition_tracks.map((t) => [t.id, t.levels[0]!.id]));
}

/** 화면·GM에 보이는 단계: 숨은 단계(감염 잠복기 등)는 바로 앞의 보이는 단계로 */
export function shownLevel(track: ConditionTrack, levelId: string | undefined) {
  let index = Math.max(0, track.levels.findIndex((l) => l.id === levelId));
  while (index > 0 && track.levels[index]!.hidden) index--;
  return track.levels[index]!;
}

/** 상태 트랙들의 판정 보정 합 */
export function conditionPenalty(s: Scenario, character: Pick<Character, "conditions">): number {
  return s.condition_tracks.reduce((sum, track) => {
    const level = track.levels.find((l) => l.id === character.conditions[track.id]);
    return sum + (level?.penalty ?? 0);
  }, 0);
}

/** "부상: 경상, 감염: 없음" 같은 상태 요약 */
export function describeConditions(s: Scenario, character: Pick<Character, "conditions">): string {
  return s.condition_tracks
    .map((t) => `${t.label}: ${shownLevel(t, character.conditions[t.id]).label}`)
    .join(", ");
}

/** 트랙을 steps 단계만큼 악화시킨다. 마지막 단계에서 멈춘다 */
export function worsen(track: ConditionTrack, levelId: string, steps: number) {
  const index = track.levels.findIndex((l) => l.id === levelId);
  const next = track.levels[Math.min(index + steps, track.levels.length - 1)]!;
  return { to: next.id, fatal: next.fatal === true };
}

export type SpeechLevel = string;

/**
 * 기본 화법 (기획서 7.4). 지휘 계통상의 높이와 나이로 정한다.
 * 형태 이름(반말/존댓말)과 규칙은 시나리오의 화법 파일에서 온다. NPC의 voice.style이 우선한다.
 */
export function speechLevel(
  s: Scenario,
  speaker: { rank: string; age: number | null },
  listener: { rank: string; age: number | null },
): SpeechLevel {
  const rules = s.speech;
  const diff = (rankOf(s, speaker.rank)?.level ?? 0) - (rankOf(s, listener.rank)?.level ?? 0);
  let form: "casual" | "polite";
  if (diff > 0) form = rules.to_lower_rank;
  else if (diff < 0) form = rules.to_higher_rank;
  else if (speaker.age === null || listener.age === null) form = rules.unknown_age;
  else form = speaker.age >= listener.age ? rules.same_rank_older_or_same_age : rules.same_rank_younger;
  return rules.forms[form];
}
