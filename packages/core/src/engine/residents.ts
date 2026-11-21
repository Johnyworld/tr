import { heldOf } from "../rules/held.ts";
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import { activeCompanions } from "../game/companions.ts";
import { isCreature } from "../game/kinds.ts";
import { dayOf, MINUTES_PER_DAY, SEGMENT_START_HOUR } from "../rules/time.ts";
import { trackOf } from "../scenario/scenario.ts";
import { daysOfStock, rationLevel } from "../sim/war.ts";
import { changeCondition } from "./body.ts";
import { outsideTemp } from "./climate.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 거점에 사는 사람들의 몸 (기획서 4.5.4, 12-125): 무리의 형편이 사람 몸에 보인다.
 * - 허기: 하루마다 그 무리의 배급 수준을 주인공과 같은 규칙으로 (정량이면 나아지고, 모자라면 그 배급의 상한까지 배고파진다)
 * - 추위: 무리의 연료가 모자라 거점에 불을 못 때고 새벽 실내가 춥다면 하루 한 단계, 따뜻하면 한 단계 풀린다
 * - 죽지 않는다: body.residents의 상한(굶주림·오한)까지만. 사람이 죽는 것은 전쟁 시뮬레이션의 인구 감소가 맡는다
 * 주인공, 동행(주인공과 함께 계산), 갇힌 사람, 떠난 사람, 무리 없는 사람, 동물·감염체는 빠진다
 */

const indexOf = (content: Content, trackId: string, levelId: string | undefined) =>
  levelId ? trackOf(content.scenario, trackId).levels.findIndex((l) => l.id === levelId) : -1;

function residents(ctx: ToolContext): Character[] {
  const state = ctx.store.getState();
  const companions = new Set(activeCompanions(state));
  return Object.values(state.characters).filter(
    (c) => c.id !== state.playerId && !c.dead && !c.away && !heldOf(c) && !!c.factionId && !!state.factions[c.factionId] && !companions.has(c.id) && !isCreature(ctx.content, c),
  );
}

export function runResidentBodies(ctx: ToolContext, day: number = dayOf(ctx.store.getState().time)): ToolDisplayEvent[] {
  const { content } = ctx;
  const rules = content.scenario.body?.residents;
  const war = content.scenario.war;
  if (!rules || !war) return [];
  const displays: ToolDisplayEvent[] = [];
  const show = (id: string, d: ToolDisplayEvent | null | undefined) => {
    if (d && ctx.store.getState().scene.present.includes(id)) displays.push(d);
  };
  const hunger = content.scenario.body?.hunger?.track;
  const cold = content.scenario.body?.cold;
  const climate = cold?.climate;
  // 새벽 바깥 기온 (그날 가장 추운 때)
  const dawn = (day - 1) * MINUTES_PER_DAY + SEGMENT_START_HOUR.dawn * 60;
  const outside = climate ? outsideTemp(content, ctx.store.getState(), dawn) : null;

  for (const c of residents(ctx)) {
    const state = ctx.store.getState();
    const faction = state.factions[c.factionId]!;
    if (hunger && rules.hunger_max) {
      const level = rationLevel(content, faction);
      const now = indexOf(content, hunger, c.conditions[hunger]) < 0 ? 0 : indexOf(content, hunger, c.conditions[hunger]);
      let delta = level.hunger ?? 1; // 배급 단계에 허기 변화가 없으면 하루 한 단계 (주인공의 하루 몸과 같다)
      if (delta > 0) {
        const caps = [indexOf(content, hunger, level.hunger_max), indexOf(content, hunger, rules.hunger_max)].filter((i) => i >= 0);
        delta = Math.max(0, Math.min(delta, Math.min(...caps) - now));
      }
      if (delta !== 0) show(c.id, changeCondition(ctx, c.id, hunger, delta, "daily", delta < 0 ? `배급 (${level.label})` : `배급 부족 (${level.label})`)?.display);
    }
    if (cold && climate && cold.shelter && outside && rules.cold_max) {
      const base = Object.values(content.locations).find((l) => l.owner === c.factionId && l.kind === "base");
      const heated = daysOfStock(content, faction, cold.shelter.resource) >= cold.shelter.min_days;
      const indoor = outside.value + (base?.cover ?? 0);
      const now = Math.max(0, indexOf(content, cold.track, c.conditions[cold.track]));
      const cap = indexOf(content, cold.track, rules.cold_max);
      if (!heated && indoor < climate.comfort) {
        if (now < cap) show(c.id, changeCondition(ctx, c.id, cold.track, 1, "cold", `불 못 땐 거처 (새벽 ${indoor}°)`)?.display);
      } else if (now > 0) {
        show(c.id, changeCondition(ctx, c.id, cold.track, -1, "cold", heated ? "불 땐 거처" : "따뜻한 날")?.display);
      }
    }
  }
  return displays;
}
