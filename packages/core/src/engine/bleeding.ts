import type { Character } from "../game/character.ts";
import type { CheckOutcome } from "../rules/check.ts";
import { harmTrack, trackOf } from "../scenario/scenario.ts";
import { changeCondition } from "./body.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 상처 종류와 출혈 (기획서 4.4, 12-91).
 * - 피가 나는 종류(wounds.kinds[].bleeds)로 다치면 부상 단계에 맞춰(from_harm) 출혈 트랙이 오른다. 내려가지는 않는다
 * - 출혈은 판정 보정이 없다. 시간이 흐르면 worsen_hours마다 부상이 한 단계 나빠지고, clot_hours가 지나면 저절로 멎는다
 * - blocks_recovery_from 이상이면 정신이 들지 않고 저절로 낫지 않는다 (지혈해야 한다)
 * - 지혈: 붕대·구급상자(consumables), 치료사(recovery.healer), 맨손 지혈 판정(staunch_move), 곁의 사람의 돌봄(12-90)
 * 지금은 주인공만 흘린다 (NPC 출혈은 다음 단계)
 */

const rules = (ctx: ToolContext) => ctx.content.scenario.wounds;

const levelIndexOf = (ctx: ToolContext, c: Pick<Character, "conditions">, trackId: string) => {
  const t = trackOf(ctx.content.scenario, trackId);
  return Math.max(0, t.levels.findIndex((l) => l.id === c.conditions[trackId]));
};

/** 상처 종류 id가 이 월드에 있는지, 피가 나는지 */
export function woundKind(ctx: ToolContext, id: string | null | undefined) {
  return id ? rules(ctx)?.kinds.find((k) => k.id === id) : undefined;
}

/** 다친 직후: 피가 나는 상처면 부상 단계만큼 출혈이 오른다. 화면에 알릴 줄 */
export function bleedFromHarm(ctx: ToolContext, characterId: string, kind: string | null | undefined): { line: string; display: ToolDisplayEvent | null } | null {
  const w = rules(ctx);
  if (!w || !woundKind(ctx, kind)?.bleeds) return null;
  const c = ctx.store.getState().characters[characterId];
  if (!c || c.dead) return null;
  const harm = harmTrack(ctx.content.scenario);
  const target = w.from_harm[c.conditions[harm.id] ?? ""];
  if (!target) return null;
  const track = trackOf(ctx.content.scenario, w.track);
  const want = track.levels.findIndex((l) => l.id === target);
  const now = levelIndexOf(ctx, c, w.track);
  if (want <= now) return null;
  const ch = changeCondition(ctx, characterId, w.track, want - now, "wound", "상처에서 피가 난다");
  return ch ? { line: ch.line, display: ch.display } : null;
}

/** 지금 출혈이 회복(정신이 듦·저절로 낫기)을 막는지 */
export function bleedingBlocksRecovery(ctx: ToolContext, c: Pick<Character, "conditions">): boolean {
  const w = rules(ctx);
  if (!w) return false;
  const track = trackOf(ctx.content.scenario, w.track);
  const from = track.levels.findIndex((l) => l.id === w.blocks_recovery_from);
  return from >= 0 && levelIndexOf(ctx, c, w.track) >= from;
}

/** 피를 멎게 한다 (돌봄·치료). 화면에 알릴 것 */
export function stopBleeding(ctx: ToolContext, characterId: string, cause: string, steps?: number): ToolDisplayEvent[] {
  const w = rules(ctx);
  const c = ctx.store.getState().characters[characterId];
  if (!w || !c || c.dead) return [];
  const now = levelIndexOf(ctx, c, w.track);
  if (now === 0) return [];
  const ch = changeCondition(ctx, characterId, w.track, -(steps ?? now), "healer", cause);
  return ch?.display ? [ch.display] : [];
}

/** 맨손 지혈 (옷을 찢어 누른다): 판정 결과대로. 성공이면 멎고, 대가 있는 성공이면 한 단계, 실패면 그대로 */
export function staunch(ctx: ToolContext, check: { move: string; outcome: CheckOutcome } | null): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  const w = rules(ctx);
  if (!w) return { ok: false, error: "이 월드에는 출혈 규칙이 없다." };
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  if (levelIndexOf(ctx, me, w.track) === 0) return { ok: false, error: "피가 나지 않는다. 지혈할 것이 없다." };
  if (!check || check.move !== w.staunch_move) {
    return { ok: false, error: `아이템 없이 지혈하려면 check(move: ${w.staunch_move})를 함께 선언한다 (옷을 찢어 누르기 등). 붕대·구급상자가 있으면 treatment.item으로.` };
  }
  if (check.outcome === "miss") return { ok: true, lines: ["지혈하지 못했다. 피가 계속 난다."], displays: [] };
  const displays = stopBleeding(ctx, me.id, "맨손 지혈", check.outcome === "success" ? undefined : 1);
  return { ok: true, lines: [check.outcome === "success" ? "피를 멎게 했다." : "피가 조금 줄었지만 아직 멎지 않았다."], displays };
}

/** 시간이 흐른 뒤마다 (runAfterTimeAdvance): 출혈이 부상을 키우거나 저절로 멎는다 */
export function runBleeding(ctx: ToolContext): ToolDisplayEvent[] {
  const w = rules(ctx);
  if (!w) return [];
  const displays: ToolDisplayEvent[] = [];
  const track = trackOf(ctx.content.scenario, w.track);
  const harm = harmTrack(ctx.content.scenario);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead || state.battle) return [];
  const level = track.levels[levelIndexOf(ctx, me, w.track)]!;
  const since = state.recovery.trackAt[`${me.id}:${w.track}`] ?? state.time;
  const elapsed = state.time - since;
  const clot = w.clot_hours[level.id];
  if (clot !== undefined && elapsed >= clot * 60) return stopBleeding(ctx, me.id, "피가 저절로 멎었다");
  const every = w.worsen_hours[level.id];
  if (every === undefined) return [];
  const times = Math.floor(elapsed / (every * 60));
  if (times <= 0) return [];
  const ch = changeCondition(ctx, me.id, harm.id, times, "bleeding", "피를 많이 흘렸다");
  if (ch?.display) displays.push(ch.display);
  if (!ctx.store.getState().characters[me.id]!.dead) ctx.store.append({ type: "track_clock_reset", characterId: me.id, track: w.track });
  return displays;
}
