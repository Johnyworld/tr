import { heldOf } from "../rules/held.ts";
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import type { Clash, GameState } from "../game/state.ts";
import type { CheckOutcome } from "../rules/check.ts";
import { seasonAt } from "../sim/season.ts";
import { josa } from "../text.ts";
import { recordDeed } from "./reputationTools.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 거점 손보기 (기획서 4.8.3, 12-167). 시설은 구역에 붙는다. 떠돌이의 거처(4.8.1)와 무리의 거점에 짓는다.
 * - 짓기: take_action.build + 판정(시설의 move). 재료는 지닌 것에서, 시간은 시설의 hours. 결과는 코드가 정한다 (원칙 2)
 *   성공 = 짓는다, 대가 있는 성공 = 짓되 더 오래 걸린다, 실패 = 재료 절반을 버리고 못 짓는다
 * - 무리 거점에는 누구나 지을 수 있다 (허락 없음). 지으면 성실함 행적이 남는다
 * - 효과는 지금 있는 장치로만: 담(fort), 야영 이야기 확률(camp), 지켜보는 밤(watched), 물이 나는 곳(water),
 *   텃밭(garden: 거처면 주인공의 창고에, 거점이면 무리 자원에), 날것이 안 상한다(preserve), 실내의 불(fire)
 * - 닳기: 시간으로는 닳지 않는다. 그 구역에 습격·공격이 오면 시설 하나가 부서진다 (재난도 같은 길, 9.18)
 */

type Facility = NonNullable<Content["scenario"]["facilities"]>[number];

const rules = (content: Content) => content.scenario.facilities ?? [];
export const facilityOf = (content: Content, id: string) => rules(content).find((f) => f.id === id);

/** 이 구역에 지어진 시설 */
export function facilitiesAt(content: Content, state: GameState, zone: string | null | undefined): Facility[] {
  if (!zone) return [];
  return (state.facilities?.[zone] ?? []).map((id) => facilityOf(content, id)).filter((f): f is Facility => !!f);
}

/** 지금 이 자리에 시설을 지을 수 있다면 어떤 자리인지: 떠돌이의 거처(home), 우리 무리의 거점(base), 거점 밖 우리 무리의 땅(own, 12-184) */
export function buildSite(content: Content, state: GameState): "home" | "base" | "own" | null {
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!me || me.dead || heldOf(me) || !zone) return null;
  if (state.homes[me.id] === zone) return "home";
  if (me.factionId && content.locations[zone]?.kind === "base" && state.zones[zone]?.owner === me.factionId) return "base";
  if (me.factionId && state.zones[zone]?.owner === me.factionId) return "own";
  return null;
}

/** 지을 수 없는 까닭 (없으면 null) */
export function planBuild(content: Content, state: GameState, me: Character, id: string, move: string | undefined): string | null {
  const f = facilityOf(content, id);
  if (!f) return `알 수 없는 시설: ${id} (가능: ${rules(content).map((x) => x.id).join(", ") || "없음"})`;
  const site = buildSite(content, state);
  if (!site) return "시설은 내 거처(떠돌이)나 우리 무리의 땅에서만 짓는다.";
  if (!f.where.includes(site)) return `${josa(f.label, "은/는")} ${site === "home" ? "거처" : site === "base" ? "거점" : "거점 밖"}에 짓지 않는다.`;
  if ((state.facilities?.[state.playerZone!] ?? []).includes(f.id)) return `이 구역에는 이미 ${josa(f.label, "이/가")} 있다.`;
  if (move !== f.move) return `${josa(f.label, "을/를")} 지으려면 check.move가 ${f.move}여야 한다.`;
  const missing = Object.entries(f.materials).filter(([item, n]) => (me.inventory[item] ?? 0) < n);
  if (missing.length) return `재료가 모자라다: ${missing.map(([item, n]) => `${content.items[item]?.name ?? item} ${n}개`).join(", ")}.`;
  return null;
}

/** 판정 결과대로 짓는다. 더 걸리는 시간(분)과 알릴 줄 */
export function applyBuild(ctx: ToolContext, id: string, outcome: CheckOutcome): { lines: string[]; extraMinutes: number } {
  const { store, content } = ctx;
  const f = facilityOf(content, id)!;
  const state = store.getState();
  const me = state.characters[state.playerId]!;
  const zone = state.playerZone!;
  const site = buildSite(content, state);
  if (outcome === "miss") {
    for (const [item, n] of Object.entries(f.materials)) {
      const lost = Math.floor(n / 2);
      if (lost > 0) store.append({ type: "item_consumed", holder: me.id, itemId: item, quantity: lost });
    }
    return { lines: [`${josa(f.label, "을/를")} 짓지 못했다. 재료 절반을 버렸다.`], extraMinutes: 0 };
  }
  for (const [item, n] of Object.entries(f.materials)) store.append({ type: "item_consumed", holder: me.id, itemId: item, quantity: n });
  store.append({ type: "facility_built", zone, facility: f.id });
  const lines = [`${content.locations[zone]?.name ?? zone}에 ${josa(f.label, "을/를")} 지었다${outcome === "partial" ? " (생각보다 오래 걸렸다)" : ""}. ${f.description}`];
  // 무리의 땅(거점, 거점 밖 우리 땅 12-184)이면 담이 되고 성실함 행적이 남는다
  if (site === "base" || site === "own") {
    if (f.effects.fort) store.append({ type: "zone_fortified", zone, delta: f.effects.fort });
    recordDeed(ctx, { summary: `${site === "base" ? "거점" : `${content.locations[zone]?.name ?? zone}`}에 ${josa(f.label, "을/를")} 지었다`, tags: ["diligence"], severity: 1, privacy: "public", noisy: true });
  }
  const base = Math.max(0, f.hours * 60 - 120);
  return { lines, extraMinutes: outcome === "partial" ? base + Math.round(f.hours * 30) : base };
}

/** 시설 효과: 이 구역의 야영 이야기 확률 배수 */
export function campFactor(content: Content, state: GameState, zone: string | null | undefined): number {
  return facilitiesAt(content, state, zone).reduce((n, f) => n * (f.effects.camp ?? 1), 1);
}
/** 시설 효과: 잠들어도 지켜보는 밤으로 친다 (경보줄) */
export const watchedHere = (content: Content, state: GameState) => facilitiesAt(content, state, state.playerZone).some((f) => f.effects.watched);
/** 시설 효과: 물이 나는 곳 (빗물받이) */
export const waterFacilityHere = (content: Content, state: GameState) => facilitiesAt(content, state, state.playerZone).some((f) => f.effects.water);
/** 시설 효과: 날것이 안 상한다 (훈제 막) */
export const preservesHere = (content: Content, state: GameState) => facilitiesAt(content, state, state.playerZone).some((f) => f.effects.preserve);
/** 시설 효과: 난로가 있다 (땔감을 넣으면 오래 타고 실내만 따뜻하다, 12-190) */
export const stoveAt = (content: Content, state: GameState, zone: string | null | undefined) => facilitiesAt(content, state, zone).some((f) => f.effects.fire);

/** 하루가 지나면: 텃밭이 자란다. 거처면 garden.days마다 주인공의 창고에, 거점이면 날마다 무리 자원에 (자라는 계절에만) */
export function runFacilitiesDaily(ctx: ToolContext, day: number): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const state = store.getState();
  const season = seasonAt(content.scenario, (day - 1) * 24 * 60)?.id ?? "";
  for (const [zone, ids] of Object.entries(state.facilities ?? {})) {
    for (const id of ids) {
      const g = facilityOf(content, id)?.effects.garden;
      if (!g || (g.seasons.length && !g.seasons.includes(season))) continue;
      const owner = state.zones[zone]?.owner;
      const isBase = content.locations[zone]?.kind === "base" && owner;
      if (isBase && g.resource) {
        store.append({ type: "faction_resource_changed", factionId: owner!, resource: g.resource, delta: g.resource_delta });
        continue;
      }
      const dweller = Object.entries(state.homes).find(([, z]) => z === zone)?.[0];
      if (!dweller || state.characters[dweller]?.dead || day % g.days !== 0) continue;
      store.append({ type: "item_granted", to: dweller, itemId: g.item, quantity: g.qty });
      store.append({ type: "item_stashed", characterId: dweller, zone, itemId: g.item, quantity: g.qty, direction: "put" });
    }
  }
  return [];
}

/** 그날 새벽의 교전: 시설이 있는 구역이 습격·공격을 받으면 하나가 부서진다 (담이면 담도 헐린다). 알릴 줄 */
export function breakFacilities(ctx: ToolContext, clashes: readonly Clash[]): { zone: string; line: string }[] {
  const { store, content } = ctx;
  const lines: { zone: string; line: string }[] = [];
  for (const c of clashes) {
    if (c.kind === "occupy") continue;
    const built = store.getState().facilities?.[c.zone] ?? [];
    if (!built.length) continue;
    const id = built[Math.floor(ctx.rng() * built.length)]!;
    const f = facilityOf(content, id);
    store.append({ type: "facility_broken", zone: c.zone, facility: id });
    if (f?.effects.fort) store.append({ type: "zone_fortified", zone: c.zone, delta: -f.effects.fort });
    lines.push({ zone: c.zone, line: `${content.locations[c.zone]?.name ?? c.zone}의 ${josa(f?.label ?? id, "이/가")} 싸움통에 부서졌다.` });
  }
  return lines;
}

/** GM 상태의 줄: 이 구역의 시설과 지을 수 있는 시설 */
export function describeFacilities(content: Content, state: GameState): string[] {
  if (!rules(content).length) return [];
  const out: string[] = [];
  const here = facilitiesAt(content, state, state.playerZone);
  if (here.length) out.push(`이 구역의 시설: ${here.map((f) => f.label).join(", ")}`);
  const site = buildSite(content, state);
  if (site) {
    const can = rules(content).filter((f) => f.where.includes(site) && !here.includes(f));
    if (can.length) {
      // 재료·시간은 짓겠다고 할 때 오류 문구로 알린다 (늘 싣지 않는다)
      out.push(`지을 수 있는 시설 (take_action.build + check(move), 플레이어가 짓겠다고 할 때만): ${can.map((f) => `${f.id} ${f.label}(${f.move})`).join(", ")}`);
    }
  }
  return out;
}

