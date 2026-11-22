import { heldOf } from "../rules/held.ts";
import { staunchHelper } from "../rules/company.ts";
import { activeCompanions } from "../game/companions.ts";
import { isCreature } from "../game/kinds.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Character } from "../game/character.ts";
import type { CheckOutcome } from "../rules/check.ts";
import { harmTrack, incapacitatingSymptom, trackOf } from "../scenario/scenario.ts";
import { changeCondition } from "./body.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 상처 종류와 출혈 (기획서 4.4, 12-91).
 * - 피가 나는 종류(wounds.kinds[].bleeds)로 다치면 부상 단계에 맞춰(from_harm) 출혈 트랙이 오른다. 내려가지는 않는다
 * - 출혈은 판정 보정이 없다. 시간이 흐르면 worsen_hours마다 부상이 한 단계 나빠지고, clot_hours가 지나면 저절로 멎는다
 * - blocks_recovery_from 이상이면 정신이 들지 않고 저절로 낫지 않는다 (지혈해야 한다)
 * - 지혈: 붕대·구급상자(consumables), 치료사(recovery.healer), 맨손 지혈 판정(staunch_move), 곁의 사람의 돌봄(12-90)
 * - 피를 흘려 부상이 깊어지면 출혈도 그 부상 단계만큼 심해진다 (from_harm)
 * - NPC도 같은 규칙으로 흘린다 (원칙 6). 주인공이 친 상처의 종류는 무기·맨손 데이터(weapon.wound)에서 온다.
 *   장면 밖의 NPC는 무리가 있으면(또는 갇혀 있으면) 곁의 사람이 지혈하고, 무리 없는 사람은 계속 흘린다
 */

const rules = (ctx: ToolContext) => ctx.content.scenario.wounds;

/** 곁의 사람이 주인공의 피를 멎게 하기까지 (분) */
/** 갇힌 주인공의 상처를 붙잡은 쪽이 묶어 주기까지 (분) */
const HELPER_STAUNCH_MINUTES = 60;

const levelIndexOf = (ctx: ToolContext, c: Pick<Character, "conditions">, trackId: string) => {
  const t = trackOf(ctx.content.scenario, trackId);
  return Math.max(0, t.levels.findIndex((l) => l.id === c.conditions[trackId]));
};

/** 상처 종류 id가 이 월드에 있는지, 피가 나는지 */
export function woundKind(ctx: ToolContext, id: string | null | undefined) {
  return id ? rules(ctx)?.kinds.find((k) => k.id === id) : undefined;
}

/** 다친 직후: 피가 나는 상처면 부상 단계만큼 출혈이 오른다. 화면에 알릴 줄 */
export function bleedFromHarm(ctx: ToolContext, characterId: string, kind: string | null | undefined, light = false): { line: string; display: ToolDisplayEvent | null } | null {
  if (!rules(ctx) || !woundKind(ctx, kind)?.bleeds) return null;
  // 가볍게 선언한 위험이면 출혈은 가장 낮은 단계까지만 (플레이 테스트 11: 가벼운 위험에 "심한 출혈")
  return raiseBleeding(ctx, characterId, "상처에서 피가 난다", light ? 1 : undefined);
}

/** 지금 부상 단계에 맞춰 출혈을 올린다 (내리지는 않는다) */
function raiseBleeding(ctx: ToolContext, characterId: string, cause: string, cap?: number): { line: string; display: ToolDisplayEvent | null } | null {
  const w = rules(ctx);
  if (!w) return null;
  const c = ctx.store.getState().characters[characterId];
  if (!c || c.dead) return null;
  const harm = harmTrack(ctx.content.scenario);
  const target = w.from_harm[c.conditions[harm.id] ?? ""];
  if (!target) return null;
  const track = trackOf(ctx.content.scenario, w.track);
  const want = Math.min(track.levels.findIndex((l) => l.id === target), cap ?? Infinity);
  const now = levelIndexOf(ctx, c, w.track);
  if (want <= now) return null;
  const ch = changeCondition(ctx, characterId, w.track, want - now, "wound", cause);
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
  // 지혈은 치료사의 치료가 아니다: "healer"로 남기면 그날 의무실 치료가 막혔다 (플레이 테스트 8)
  const ch = changeCondition(ctx, characterId, w.track, -(steps ?? now), "staunch", cause);
  return ch?.display ? [ch.display] : [];
}

/** 맨손 지혈 (옷을 찢어 누른다): 판정 결과대로. 성공이면 멎고, 대가 있는 성공이면 심한 출혈만 한 단계 줄고 나머지는 멎는다 (12-195), 실패면 그대로 */
export function staunch(
  ctx: ToolContext,
  check: { move: string; outcome: CheckOutcome } | null,
  targetId?: string,
): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  const w = rules(ctx);
  if (!w) return { ok: false, error: "이 월드에는 출혈 규칙이 없다." };
  const state = ctx.store.getState();
  const me = state.characters[targetId ?? state.playerId];
  if (!me || me.dead) return { ok: false, error: "그 사람이 없다." };
  if (levelIndexOf(ctx, me, w.track) === 0) return { ok: false, error: "피가 나지 않는다. 지혈할 것이 없다." };
  if (!check || check.move !== w.staunch_move) {
    return { ok: false, error: `아이템 없이 지혈하려면 check(move: ${w.staunch_move})를 함께 선언한다 (옷을 찢어 누르기 등). 붕대·구급상자가 있으면 treatment.item으로.` };
  }
  if (check.outcome === "miss") return { ok: true, lines: ["지혈하지 못했다. 피가 계속 난다."], displays: [] };
  // 대가 있는 성공: 심한 출혈(트랙 끝 단계)은 한 단계만, 그보다 가벼우면 멎는다 (떠돌이가 맨손 지혈을 거의 못 했다, 플레이 테스트 9)
  const heavy = levelIndexOf(ctx, me, w.track) >= trackOf(ctx.content.scenario, w.track).levels.length - 1;
  const partialStep = check.outcome !== "success" && heavy;
  const displays = stopBleeding(ctx, me.id, "맨손 지혈", partialStep ? 1 : undefined);
  // 지혈한 순간부터 다시 센다 (남은 출혈이 바로 부상을 키우지 않게)
  if (partialStep) ctx.store.append({ type: "track_clock_reset", characterId: me.id, track: w.track });
  return { ok: true, lines: [partialStep ? "피가 조금 줄었지만 아직 멎지 않았다." : check.outcome === "success" ? "피를 멎게 했다." : "한참을 눌러 겨우 피를 멎게 했다. 손이 피투성이다."], displays };
}

/** 시간이 흐른 뒤마다 (runAfterTimeAdvance): 피를 흘리는 모든 사람의 출혈이 부상을 키우거나 저절로 멎는다 */
export function runBleeding(ctx: ToolContext): ToolDisplayEvent[] {
  const w = rules(ctx);
  const state = ctx.store.getState();
  if (!w || state.battle) return [];
  const displays: ToolDisplayEvent[] = [];
  const bleeding = Object.values(state.characters)
    .filter((c) => !c.dead && !c.away && levelIndexOf(ctx, c, w.track) > 0)
    .map((c) => c.id)
    .sort((a, b) => (a === state.playerId ? -1 : b === state.playerId ? 1 : a.localeCompare(b)));
  for (const id of bleeding) {
    const now = ctx.store.getState();
    // 화면에는 주인공과 장면에 있는 사람의 변화만
    const seen = id === now.playerId || now.scene.present.includes(id);
    for (const d of bleedOne(ctx, id)) if (seen) displays.push(d);
  }
  return displays;
}

/** 한 사람의 출혈: 장면 밖의 무리 사람은 곁의 사람이 지혈하고, 아니면 흘린 시간만큼 부상이 커지거나 긁힘이 멎는다 */
function bleedOne(ctx: ToolContext, id: string): ToolDisplayEvent[] {
  const w = rules(ctx)!;
  const state = ctx.store.getState();
  const c = state.characters[id]!;
  if (id !== state.playerId && !state.scene.present.includes(id) && !state.companions.includes(id) && (c.factionId || heldOf(c))) {
    return stopBleeding(ctx, id, heldOf(c) ? "붙잡은 쪽이 상처를 묶었다" : "곁의 동료가 지혈했다");
  }
  const track = trackOf(ctx.content.scenario, w.track);
  const harm = harmTrack(ctx.content.scenario);
  const level = track.levels[levelIndexOf(ctx, c, w.track)]!;
  const since = state.recovery.trackAt[`${id}:${w.track}`] ?? state.time;
  const elapsed = state.time - since;
  const clot = w.clot_hours[level.id];
  if (clot !== undefined && elapsed >= clot * 60) return stopBleeding(ctx, id, "피가 저절로 멎었다");
  // 곁의 사람 (플레이 테스트 8, 12-256 공통 규칙 8): 위협이 장면에 없으면 그 행동이 끝날 때 곁의 동행이나 같은 무리 사람이 지혈한다
  if (id === state.playerId) {
    const helper = staunchHelper(state, ctx.content, id);
    if (helper && !helper.blocked) return stopBleeding(ctx, id, `곁에 있던 ${playerCalls(state, ctx.content, helper.id)}의 지혈`);
    // 갇힌 주인공은 붙잡은 쪽이 묶어 준다: 노역에 쓰거나 몸값을 받을 포로다 (플레이 테스트 12: 감방에서 세 시간 동안 피를 흘리다 죽었다)
    if (heldOf(c) && elapsed >= HELPER_STAUNCH_MINUTES) return stopBleeding(ctx, id, "붙잡은 쪽이 상처를 묶었다");
  }
  const every = w.worsen_hours[level.id];
  if (every === undefined) return [];
  const times = Math.floor(elapsed / (every * 60));
  if (times <= 0) return [];
  const displays: ToolDisplayEvent[] = [];
  const ch = changeCondition(ctx, id, harm.id, times, "bleeding", "피를 많이 흘렸다");
  if (ch?.display) displays.push(ch.display);
  if (ctx.store.getState().characters[id]!.dead) return displays;
  // 부상이 깊어진 만큼 출혈도 심해진다
  const up = raiseBleeding(ctx, id, "상처가 더 벌어졌다");
  if (up?.display) displays.push(up.display);
  ctx.store.append({ type: "track_clock_reset", characterId: id, track: w.track });
  return displays;
}
