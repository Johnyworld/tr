import { z } from "zod";
import type { Content, ExtraContent } from "../content/schemas.ts";
import { createCharacterSchema, type Character } from "../game/character.ts";
import { generateName } from "../game/names.ts";
import type { GameState } from "../game/state.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import type { Rng } from "../rng.ts";
import { initialConditions, rankLabel } from "../scenario/scenario.ts";
import { josa } from "../text.ts";
import { defineTool, type ToolContext } from "./toolkit.ts";

/**
 * 엑스트라 (기획서 7.5): 이름 없는 인물이 주인공과 엮이면 캐릭터가 된다.
 * GM은 틀과 호칭만 고르고, 능력·소지품·트레잇·겉모습은 코드가 틀에서 굴린다 (원칙 2).
 * 이름은 주인공이 묻거나 가까워지면 learn_name으로 얻는다. 이름 없이 오래 엮이지 않으면 사라진다
 */

/** 이름을 얻지 못한 엑스트라가 사라지기까지 (마지막으로 엮인 뒤, *임시*) */
export const EXTRA_FADE_DAYS = 3;

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const between = (rng: Rng, [lo, hi]: readonly [number, number]) => lo + Math.floor(rng() * (hi - lo + 1));

/** 틀로 캐릭터를 만든다 (같은 캐릭터 스키마, 원칙 6) */
export function createExtraCharacter(
  content: Content,
  template: ExtraContent,
  input: { id: string; label: string; zone: string | null; time: number },
  rng: Rng,
): Character {
  const s = content.scenario;
  const genders = s.creation?.genders.map((g) => g.id) ?? [];
  const gender = template.gender ?? (genders.length ? pick(rng, genders) : null);
  const stats = Object.fromEntries(Object.entries(template.stats).map(([k, range]) => [k, between(rng, range!)]));
  const pool = [...template.traits];
  const traits: string[] = [];
  for (let i = 0; i < template.trait_count && pool.length; i++) {
    const t = pool.splice(Math.floor(rng() * pool.length), 1)[0]!;
    const def = s.traits.find((x) => x.id === t);
    if (def && !def.opposites.some((o) => traits.includes(o))) traits.push(t);
  }
  const inventory: Record<string, number> = {};
  for (const i of template.inventory) if (rng() < i.chance) inventory[i.item] = (inventory[i.item] ?? 0) + i.quantity;
  return createCharacterSchema(s).parse({
    id: input.id,
    name: input.label,
    factionId: template.faction ?? "",
    rank: template.rank,
    age: between(rng, template.age),
    gender,
    stats,
    skills: template.skills,
    traits,
    conditions: initialConditions(s),
    inventory,
    extra: { template: template.id, label: input.label, look: pick(rng, template.looks), zone: input.zone, lastSeenAt: input.time, named: false, gone: false },
  });
}

/** 이 인물의 가치관 (콘텐츠 NPC면 프로필, 엑스트라면 틀) — 행적에 대한 반응에 쓴다 */
export function valuesOf(content: Content, state: GameState, id: string): Record<string, number> {
  const npc = content.npcs[id];
  if (npc) return npc.values;
  const tpl = state.characters[id]?.extra?.template;
  return (tpl && content.extras[tpl]?.values) || {};
}

/** 살아 있는(사라지지 않은) 엑스트라인지 */
export const isActiveExtra = (c: Character | undefined) => !!c?.extra && !c.extra.gone;

const spawnExtra = defineTool({
  name: "spawn_extra",
  description:
    "이름 없는 인물(보초, 피난민, 짐꾼 등)이 주인공과 엮일 때(말을 걸거나, 싸우거나, 거래하거나, 뒤질 때) 그 인물을 캐릭터로 만들어 장면에 넣는다. " +
    "상태의 \"엑스트라 틀\" 중 하나를 고르고 호칭을 붙인다. 능력·소지품·겉모습은 시스템이 정한다 (물건을 지어내지 않는다: 서술에 엽총을 묘사했으면 엽총이 있는 틀을 고른다). " +
    "지나가기만 하는 배경 인물에는 쓰지 않는다. 이름은 아직 모른다 (learn_name).",
  schema: z.strictObject({
    template: z.string().describe("엑스트라 틀 id"),
    label: z.string().min(1).max(30).describe("서술에서 부르는 호칭 (예: 엽총 든 보초)"),
  }),
  run(input, ctx) {
    const { store, content, rng } = ctx;
    const state = store.getState();
    const template = content.extras[input.template];
    if (!template) return { ok: false, error: `알 수 없는 엑스트라 틀: ${input.template} (가능: ${Object.keys(content.extras).join(", ")})` };
    const player = state.characters[state.playerId];
    if (!player || player.dead) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
    const id = `ex_${state.nextExtraNo}`;
    const character = createExtraCharacter(content, template, { id, label: input.label, zone: state.playerZone, time: state.time }, rng);
    store.append({ type: "extra_spawned", character });
    const items = Object.entries(character.inventory).map(([i, q]) => `${content.items[i]?.name ?? i}(${i}) ×${q}`);
    return {
      ok: true,
      resultText:
        `${josa(input.label, "이/가")} 장면에 들어왔다 (id: ${id}, ${rankLabel(content.scenario, character.rank)}). 겉모습: ${character.extra!.look}. ` +
        `지닌 것: ${items.join(", ") || "눈에 띄는 것 없음"}. 이 인물은 이제 판정 대상(target)이 되고 행적을 본다. 이름은 아직 모른다.`,
      display: { type: "presence", npcName: input.label, action: "enter" },
    };
  },
});

const learnName = defineTool({
  name: "learn_name",
  description:
    "이름 없는 엑스트라(id ex_N)의 이름을 주인공이 알게 됐을 때 부른다: 주인공이 이름을 묻고 상대가 답하거나, 사이가 가까워졌을 때(호감·신뢰 2 이상). " +
    "시스템이 이름을 지어 주고, 그 인물은 사라지지 않는 인물이 된다. 이름을 지어내지 말고 결과의 이름을 쓴다.",
  schema: z.strictObject({ target: z.string().describe("엑스트라 id (ex_N)") }),
  run(input, ctx) {
    const { store, content, rng } = ctx;
    const state = store.getState();
    const c = state.characters[input.target];
    if (!c?.extra || c.extra.gone) return { ok: false, error: `엑스트라가 아니다: ${input.target}` };
    if (c.extra.named) return { ok: false, error: `${josa(c.name, "은/는")} 이미 이름을 안다.` };
    if (!state.scene.present.includes(c.id)) return { ok: false, error: `${josa(c.extra.label, "은/는")} 지금 장면에 없다.` };
    const used = new Set(Object.values(state.characters).map((x) => x.name));
    const name = generateName(rng, content.scenario.names, c.gender, used);
    if (!name) return { ok: false, error: "이 시나리오에는 이름 재료가 없다." };
    store.append({ type: "extra_named", characterId: c.id, name });
    return {
      ok: true,
      resultText: `${c.extra.label}의 이름은 ${name}이다. 이제 이 이름으로 부른다. (이 인물은 이제 사라지지 않는다)`,
      display: { type: "belief", fact: `${c.extra.label}의 이름은 ${name}`, sourceLabel: "직접 들음" },
    };
  },
});

export const EXTRA_TOOLS = [spawnExtra, learnName] as const;

/** 이름을 얻지 못하고 오래 엮이지 않은 엑스트라는 사라진다 (시간이 흐른 뒤마다) */
export function fadeExtras(ctx: ToolContext): void {
  const state = ctx.store.getState();
  for (const c of Object.values(state.characters)) {
    if (!c.extra || c.extra.gone || c.extra.named || state.scene.present.includes(c.id)) continue;
    if (state.time - c.extra.lastSeenAt >= EXTRA_FADE_DAYS * MINUTES_PER_DAY) ctx.store.append({ type: "extra_gone", characterId: c.id });
  }
}

/** GM 상태에 넣는 틀 목록 (고를 수 있는 것) */
export function describeExtraTemplates(content: Content): string {
  const list = Object.values(content.extras);
  if (list.length === 0) return "";
  return `엑스트라 틀 (이름 없는 인물이 주인공과 엮이면 spawn_extra로 캐릭터로 만든다):\n${list.map((t) => `- ${t.id}: ${t.label}`).join("\n")}`;
}
