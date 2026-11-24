import { arrivalPlace, movePlayer } from "../rules/place.ts";
import { heldOf, pausedWhileHeld } from "../rules/held.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { infestationOf } from "../game/infestation.ts";
import { isCreature } from "../game/kinds.ts";
import { infectedFoes } from "./opposition.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { Character } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import { harmTrack, incapacitatingSymptom } from "../scenario/scenario.ts";
import { ableNow } from "../rules/company.ts";
import { disposition } from "../sim/war.ts";
import { josa, sentence } from "../text.ts";
import { changeCondition, maybeInfect } from "./body.ts";
import { baseOf, capturePlayer } from "./captivity.ts";
import { stopBleeding } from "./bleeding.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 의식불명 중 곁의 사람 (기획서 4.4, 12-90). 원칙 3: 무슨 일이 일어나는지는 GM이 아니라 코드가 정한다.
 * 스스로 아무것도 못 하게 되면(incapacitates 증상) 그 한 번에 한 번, 곁에 누가 있느냐로 정한다:
 * - 적이 우리 편보다 많거나 같으면: 그 무리가 끌고 가 가둔다(captivity). 죽일지는 그 사람들의 가치관(mercy)과 원한으로 확률을 낸다
 * - 우리 편이 있으면: 돌봐 준다(한 단계 나아져 정신이 든다). 동행이 아닌 무리 사람이면 자기 무리 거점으로 옮긴다
 * - 장면에 아무도 없으면: 구역 주인 무리의 사람이 확률로 찾아낸다 (우리 편이면 돌봄·옮김, 적이면 붙잡음). 아무도 찾지 않으면 구역 위험만큼 감염체를 만난다
 * 전투 중에는 정하지 않는다 (전투의 패배·포로 규칙이 맡는다). 주인공은 정신이 든 뒤에 아는 만큼만 안다
 */

type Side = "ally" | "hostile" | null;

const regard = (state: GameState, from: string, to: string) => {
  const r = state.relations[from]?.[to];
  return r ? r.trust + r.affection : 0;
};

/** 이 사람이 쓰러진 주인공을 어떻게 대하는지 */
function sideOf(ctx: ToolContext, c: Character): Side {
  const rules = ctx.content.scenario.helpless!;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const toMe = regard(state, c.id, me.id);
  if (state.companions.includes(c.id) && state.bonds[c.id]?.kind !== "prisoner") return "ally";
  if (toMe <= rules.hostile_regard) return "hostile";
  if (toMe >= rules.ally_regard) return "ally";
  if (!c.factionId) return null;
  if (me.factionId && c.factionId === me.factionId) return "ally";
  if (!me.factionId) return rules.prey_on_strangers.includes(c.factionId) ? "hostile" : null;
  const d = disposition(ctx.content, c.factionId, me.factionId, state);
  if (d <= rules.hostile_disposition) return "hostile";
  return d >= 1 ? "ally" : null;
}

/** 무리 자체가 주인공을 어떻게 대하는지 (장면에 아무도 없을 때, 구역 주인) */
function factionSide(ctx: ToolContext, factionId: string): Side {
  const rules = ctx.content.scenario.helpless!;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  if (me.factionId === factionId) return "ally";
  if (!me.factionId) return rules.prey_on_strangers.includes(factionId) ? "hostile" : null;
  const d = disposition(ctx.content, factionId, me.factionId, state);
  return d <= rules.hostile_disposition ? "hostile" : d >= 1 ? "ally" : null;
}

/** 사람만 돌보거나 끌고 간다 (동물·감염체는 빠진다, 12-111) */
const isAnimal = (ctx: ToolContext, c: Character) => isCreature(ctx.content, c);

const mercyOf = (ctx: ToolContext, c: Character) =>
  ctx.content.npcs[c.id]?.values.mercy ?? (c.extra?.template ? ctx.content.extras[c.extra.template]?.values.mercy : undefined) ?? 0;

/** 시간이 흐른 뒤마다 부른다 (runAfterTimeAdvance). 화면·GM에 알릴 것을 돌려준다 */
export function runHelpless(ctx: ToolContext, actionStartedAt?: number): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const rules = content.scenario.helpless;
  if (!rules) return [];
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead) return [];
  const out = incapacitatingSymptom(content.scenario, me);
  if (!out) {
    if (state.helplessAt !== null) store.append({ type: "helpless_cleared" });
    return [];
  }
  // 이미 쓰러짐을 처리했어도, 의식이 없는 동안 곁의 움직일 수 있는 우리 편은 피를 멎게 한다 (PT23 하얀매: 응급처치 아는 동료 둘이 1시간 30분 동안 아무것도 안 해 피를 흘려 죽었다)
  if (state.helplessAt !== null && !state.battle && !pausedWhileHeld(state, "helpless") && state.playerZone) {
    const helpers = state.scene.present.map((id) => state.characters[id]).filter((c): c is Character => !!c && !isAnimal(ctx, c) && sideOf(ctx, c) === "ally" && ableNow(state, content, c.id));
    if (helpers.length > infectedFoes(content, state).length) return stopBleeding(ctx, me.id, `${playerCalls(state, content, helpers[0]!.id)}의 지혈`);
  }
  if (state.helplessAt !== null || state.battle || pausedWhileHeld(state, "helpless") || !state.playerZone) return [];
  // 이 행동에서 막 쓰러졌으면 무슨 일이 생길지는 다음에 시간이 흐를 때 정한다: 쓰러진 그 5분 안에 죽지 않게 (플레이 테스트 13)
  if (actionStartedAt !== undefined && (state.recovery.lastChangeAt[me.id] ?? -Infinity) >= actionStartedAt) return [];

  const zone = state.playerZone;
  const people = state.scene.present
    .map((id) => state.characters[id])
    .filter((c): c is Character => !!c && !c.dead && !c.away && !heldOf(c) && c.id !== me.id && !isAnimal(ctx, c));
  // 돌보거나 지켜 줄 수 있는 우리 편은 스스로 움직일 수 있는 사람만 (공통 규칙 8 ableNow)
  const allies = people.filter((c) => sideOf(ctx, c) === "ally" && ableNow(state, content, c.id));
  const hostiles = people.filter((c) => sideOf(ctx, c) === "hostile");
  // 곁의 감염체도 맞설 상대로 센다 (PT21 하얀매: 감염체가 맞붙어 있는데 중상 동료가 곧장 옮겨 갔다)
  const biters = infectedFoes(content, state);

  if (hostiles.length > 0 && hostiles.length >= allies.length) return byEnemies(ctx, hostiles, hostiles.find((c) => c.factionId)?.factionId ?? null);
  if (biters.length > 0 && biters.length >= allies.length) return bitten(ctx, biters[0]!);
  if (allies.length > 0) return byAllies(ctx, allies);

  // 장면에 아무도 없다: 구역 주인 무리의 사람이 찾아낼 수 있다
  // 지금 주인만: 주인 없는 땅이면 아무도 찾지 않는다 (공통 규칙 11, 12-269)
  const owner = state.zones[zone]?.owner ?? null;
  const side = owner ? factionSide(ctx, owner) : null;
  if (owner && side && ctx.rng() < rules.found_chance) {
    return side === "ally" ? byFaction(ctx, owner) : byEnemies(ctx, [], owner);
  }
  // 홀로 쓰러져 있다: 감염체가 많은 곳일수록 먼저 찾는다 (12-112: 구역의 감염체 압력)
  const danger = infestationOf(content, state, zone);
  if (ctx.rng() < rules.infected_chance[danger]!) return bitten(ctx, null);
  store.append({ type: "helpless_resolved", outcome: "none", by: null });
  return [];
}

/** 쓰러진 사이 감염체에게 물렸다 (by: 장면에 있던 감염체, 없으면 찾아온 무언가) */
function bitten(ctx: ToolContext, by: string | null): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const me = store.getState().characters[store.getState().playerId]!;
  store.append({ type: "helpless_resolved", outcome: "bitten", by });
  const displays: ToolDisplayEvent[] = [];
  const c = changeCondition(ctx, me.id, harmTrack(content.scenario).id, 1, "infected", "쓰러진 사이 감염체에게 물렸다");
  if (c?.display) displays.push(c.display);
  if (!c?.died) {
    const i = maybeInfect(ctx, null);
    if (i?.display) displays.push(i.display);
    displays.push(remember(ctx, "정신을 잃은 사이 무언가에게 물어뜯겼다. 몸에 이빨 자국이 남았다"));
  }
  return displays;
}

/**
 * 무리 전투가 끝났을 때 주인공이 쓰러져 있으면 (endBattle): 이겼으면 우리 무리가 돌보고, 졌으면 적의 손에 떨어진다.
 * 이 월드에 helpless 규칙이 없으면 null (포로 규칙의 on_defeat가 맡는다)
 */
export function helplessAfterBattle(ctx: ToolContext, won: boolean, ours: string, theirs: string): ToolDisplayEvent[] | null {
  if (!ctx.content.scenario.helpless) return null;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead || heldOf(me) || !incapacitatingSymptom(ctx.content.scenario, me)) return null;
  return won ? byFaction(ctx, ours) : byEnemies(ctx, [], theirs);
}

/** 주인공의 기억으로 남기고(깨어나서 아는 것), GM에게 한 줄로 알린다 */
function remember(ctx: ToolContext, text: string): ToolDisplayEvent {
  const state = ctx.store.getState();
  const fact = sentence(text);
  ctx.store.append({ type: "belief_added", characterId: state.playerId, belief: { id: `b_${state.nextBeliefNo}`, fact, source: "seen", accuracy: "approximate", learnedAt: state.time } });
  return { type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS.seen, note: `의식이 없는 동안 일어난 일 (코드가 정했다): ${fact} 주인공은 정신이 든 뒤에 이만큼만 안다. 그 전까지는 흐릿한 감각으로만 서술한다.` };
}

/** 깨어나게 돌본다: 스스로 못 하게 만든 트랙을 한 단계 낫게 한다 */
function tend(ctx: ToolContext, cause: string): ToolDisplayEvent[] {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const s = ctx.content.scenario;
  // 피부터 멎게 한다 (12-91)
  const out = stopBleeding(ctx, me.id, cause);
  const track = s.condition_tracks.find((t) => t.levels.find((l) => l.id === me.conditions[t.id])?.symptoms?.some((id) => s.symptoms?.find((x) => x.id === id)?.incapacitates));
  if (!track) return out;
  const c = changeCondition(ctx, me.id, track.id, -1, "rest", cause);
  return c?.display ? [...out, c.display] : out;
}

function byAllies(ctx: ToolContext, allies: Character[]): ToolDisplayEvent[] {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  // 동행이 아닌 다른 무리 사람이면 자기 무리 거점으로 데려간다 (같은 무리면 우리 거점으로)
  // 업고 다른 구역까지 옮기는 사람은 크게 다치지 않은 사람만 (PT21 하얀매: 중상인 동료가 구역 둘을 업고 갔다). 아니면 곁에서 돌본다
  const harm = harmTrack(ctx.content.scenario);
  const sound = (c: Character) => harm.levels.findIndex((l) => l.id === c.conditions[harm.id]) < 2;
  const carrier = allies.find((c) => c.factionId && !state.companions.includes(c.id) && sound(c));
  const base = carrier ? baseOf(ctx.store.getState(), ctx.content, carrier.factionId) : undefined;
  const name = playerCalls(state, ctx.content, allies[0]!.id);
  const known = (state.known[me.id] ?? []).includes(allies[0]!.id);
  const who = known ? name : "누군가";
  if (carrier && base && base !== state.playerZone) {
    ctx.store.append({ type: "helpless_resolved", outcome: "carried", by: carrier.id });
    movePlayer(ctx, { zone: base }, "carried");
    const place = ctx.content.locations[base]?.name ?? base;
    return [...tend(ctx, `${who}의 돌봄`), remember(ctx, `정신을 잃은 사이 ${josa(who, "이/가")} ${place}까지 옮겨 돌봐 주었다`)];
  }
  ctx.store.append({ type: "helpless_resolved", outcome: "tended", by: allies[0]!.id });
  return [...tend(ctx, `${who}의 돌봄`), remember(ctx, `정신을 잃은 사이 ${josa(who, "이/가")} 곁을 지키며 돌봐 주었다`)];
}

/** 장면에 없던 구역 주인 무리(우리 편)의 사람이 찾아냈다 */
function byFaction(ctx: ToolContext, factionId: string): ToolDisplayEvent[] {
  const state = ctx.store.getState();
  const base = baseOf(ctx.store.getState(), ctx.content, factionId);
  const name = ctx.content.factions[factionId]?.name ?? factionId;
  ctx.store.append({ type: "helpless_resolved", outcome: base && base !== state.playerZone ? "carried" : "tended", by: factionId });
  if (base && base !== state.playerZone) {
    movePlayer(ctx, { zone: base }, "carried");
    return [...tend(ctx, `${name} 사람들의 돌봄`), remember(ctx, `정신을 잃은 사이 ${name} 사람들이 찾아내 ${ctx.content.locations[base]?.name ?? base}까지 옮겨 주었다`)];
  }
  return [...tend(ctx, `${name} 사람들의 돌봄`), remember(ctx, `정신을 잃은 사이 ${name} 사람들이 찾아내 돌봐 주었다`)];
}

/** 적의 손에 떨어졌다: 확률로 죽이고, 아니면 무리가 있으면 끌고 가 가둔다 */
function byEnemies(ctx: ToolContext, hostiles: Character[], factionId: string | null): ToolDisplayEvent[] {
  const rules = ctx.content.scenario.helpless!;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const mercy = hostiles.length ? hostiles.reduce((n, c) => n + mercyOf(ctx, c), 0) / hostiles.length : 0;
  const feud = hostiles.some((c) => regard(state, c.id, me.id) <= rules.hostile_regard);
  const chance = Math.max(0, Math.min(1, rules.kill.base + rules.kill.per_mercy * mercy + (feud ? rules.kill.feud : 0)));
  const by = hostiles[0]?.id ?? factionId;
  if (ctx.rng() < chance || (!factionId && !ctx.content.scenario.captivity)) {
    ctx.store.append({ type: "helpless_resolved", outcome: "killed", by });
    const track = harmTrack(ctx.content.scenario);
    const c = changeCondition(ctx, me.id, track.id, track.levels.length, "enemy", "정신을 잃은 채 적의 손에 죽었다");
    return c?.display ? [{ ...c.display, note: `의식이 없는 동안 일어난 일 (코드가 정했다): ${c.line}` } as ToolDisplayEvent] : [];
  }
  if (factionId) {
    ctx.store.append({ type: "helpless_resolved", outcome: "captured", by: factionId });
    const line = capturePlayer(ctx, factionId, undefined, "정신을 잃은 채 끌려갔다");
    // 산 포로가 쓸모 있으니 상처는 묶어 준다 (12-91)
    if (line) stopBleeding(ctx, me.id, "붙잡은 자들이 상처를 묶었다");
    if (line) {
      const fact = ctx.store.getState().beliefs[me.id]?.at(-1)?.fact ?? line;
      return [{ type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS.seen, note: `의식이 없는 동안 일어난 일 (코드가 정했다): ${line} 주인공은 정신이 든 뒤에 이만큼만 안다.` }];
    }
    return [];
  }
  // 무리 없는 적: 죽이지 않았으면 그냥 두고 간다
  ctx.store.append({ type: "helpless_resolved", outcome: "none", by });
  return [remember(ctx, "정신을 잃은 사이 누군가 곁에 왔다가 그냥 두고 갔다")];
}
