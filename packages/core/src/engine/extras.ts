import { segmentOf } from "../rules/time.ts";
import { z } from "zod";
import type { Content, ExtraContent } from "../content/schemas.ts";
import { createCharacterSchema, type Character } from "../game/character.ts";
import { generateName } from "../game/names.ts";
import type { GameState } from "../game/state.ts";
import type { Rng } from "../rng.ts";
import { initialConditions, rankLabel } from "../scenario/scenario.ts";
import { josa } from "../text.ts";
import { aliasOf, knowsName } from "../game/acquaintance.ts";
import { firstImpression } from "./charm.ts";
import { defineTool, type ToolContext } from "./toolkit.ts";

/**
 * 엑스트라 (기획서 7.5): 이름 없는 인물이 주인공과 엮이면 캐릭터가 된다.
 * GM은 틀과 호칭만 고르고, 능력·소지품·트레잇·겉모습·이름은 코드가 굴린다 (원칙 2).
 * 이름은 처음부터 있지만 주인공은 모른다. 이름을 밝히거나 불리면 learn_name으로 알게 된다 (기획서 6.3).
 * 한 번 엮인 인물은 사라지지 않는다
 */

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const between = (rng: Rng, [lo, hi]: readonly [number, number]) => lo + Math.floor(rng() * (hi - lo + 1));

/** 틀로 캐릭터를 만든다 (같은 캐릭터 스키마, 원칙 6) */
export function createExtraCharacter(
  content: Content,
  template: ExtraContent,
  input: { id: string; label: string; zone: string | null; time: number; usedNames: ReadonlySet<string> },
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
  // 이름 재료가 없는 시나리오면 호칭이 이름이 된다
  // 동물은 사람 이름을 짓지 않는다 (호칭이 이름)
  const name = template.animal ? input.label : (generateName(rng, s.names, gender, input.usedNames) ?? input.label);
  return createCharacterSchema(s).parse({
    id: input.id,
    name,
    factionId: template.faction ?? "",
    rank: template.rank,
    age: between(rng, template.age),
    gender,
    stats,
    skills: template.skills,
    traits,
    conditions: initialConditions(s),
    inventory,
    extra: { template: template.id, label: input.label, look: pick(rng, template.looks), zone: input.zone, lastSeenAt: input.time },
    // 성적 위협은 틀이 정한 확률로 (12-59). 틀에 없으면 굴리지 않는다
    menace: template.menace && rng() < template.menace.chance ? template.menace.kind : null,
  });
}

/** 이 인물의 가치관 (콘텐츠 NPC면 프로필, 엑스트라면 틀) — 행적에 대한 반응에 쓴다 */
export function valuesOf(content: Content, state: GameState, id: string): Record<string, number> {
  const npc = content.npcs[id];
  if (npc) return npc.values;
  const tpl = state.characters[id]?.extra?.template;
  return (tpl && content.extras[tpl]?.values) || {};
}


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
    const usedNames = new Set(Object.values(state.characters).map((c) => c.name));
    const character = createExtraCharacter(content, template, { id, label: input.label, zone: state.playerZone, time: state.time, usedNames }, rng);
    store.append({ type: "extra_spawned", character });
    noteFirstMeeting(ctx, id);
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
    "장면의 인물과 플레이어 캐릭터 사이에 이름이 알려졌을 때 부른다 (기획서 6.3). 이름 있는 인물과 엑스트라 모두. " +
    "who=player: 플레이어 캐릭터가 상대의 이름을 알게 됐다 (상대가 밝혔거나, 장면의 누가 그 이름을 불렀거나, 사이가 가까워져 알려 줬다). " +
    "who=target: 상대가 플레이어 캐릭터의 이름을 알게 됐다 (플레이어가 밝혔거나 불렸다). " +
    "이름은 시스템이 이미 정해 두었다. 이름을 지어내지 말고 결과의 이름을 쓴다.",
  schema: z.strictObject({
    target: z.string().describe("장면에 있는 인물 id"),
    who: z.enum(["player", "target"]).default("player").describe("이름을 알게 되는 쪽. player: 플레이어 캐릭터가 상대 이름을, target: 상대가 플레이어 캐릭터 이름을"),
  }),
  run(input, ctx) {
    const { store, content } = ctx;
    const state = store.getState();
    const c = state.characters[input.target];
    if (!c || input.target === state.playerId) return { ok: false, error: `알 수 없는 인물: ${input.target}` };
    const alias = aliasOf(state, content, c.id);
    if (!state.scene.present.includes(c.id)) return { ok: false, error: `${josa(alias, "은/는")} 지금 장면에 없다.` };
    const player = state.characters[state.playerId]!;
    const [learner, target] = input.who === "player" ? [state.playerId, c.id] : [c.id, state.playerId];
    if (knowsName(state, learner, target)) {
      return { ok: false, error: input.who === "player" ? `이미 ${c.name}의 이름을 안다.` : `${josa(c.name, "은/는")} 이미 당신의 이름을 안다.` };
    }
    store.append({ type: "name_learned", characterId: learner, targetId: target });
    if (input.who === "target") {
      addBeliefTo(ctx, c.id, `${aliasOf(state, content, player.id)}의 이름은 ${player.name}`, "report");
      return {
        ok: true,
        resultText: `${josa(alias, "이/가")} 당신의 이름(${player.name})을 알게 됐다. 이제 이 인물은 당신을 이름으로 부를 수 있다.`,
        display: { type: "presence", npcName: knowsName(state, state.playerId, c.id) ? c.name : alias, action: "enter" },
        silent: true,
      };
    }
    const fact = `${alias}의 이름은 ${c.name}`;
    addBeliefTo(ctx, state.playerId, fact, "report");
    return {
      ok: true,
      resultText: `${alias}의 이름은 ${c.name}이다. 이제 이 이름으로 부른다.`,
      display: { type: "belief", fact, sourceLabel: "직접 들음" },
    };
  },
});

export const EXTRA_TOOLS = [spawnExtra, learnName] as const;

/**
 * 인물이 장면에 들어온다 (npc_entered). 처음 보는 사람이면 첫인상과 "이름 모름" 기억을 남긴다.
 * 장면에 인물을 들이는 곳(npc_presence, 이야기 배역, 치트)은 모두 이것을 쓴다
 */
export function enterScene(ctx: ToolContext, id: string): void {
  ctx.store.append({ type: "npc_entered", npcId: id });
  firstImpression(ctx, id);
  noteFirstMeeting(ctx, id);
}

/**
 * 이름을 모르는 인물을 처음 만나면 기억에 남긴다: "엽총 든 보초 — 이름은 모른다".
 * 나중에 이름을 알게 되면 learn_name이 "엽총 든 보초의 이름은 김철수"를 남긴다. 두 기억이 호칭과 이름을 잇는다 (기획서 6.3)
 */
function noteFirstMeeting(ctx: ToolContext, id: string): void {
  const state = ctx.store.getState();
  if (knowsName(state, state.playerId, id)) return;
  const alias = aliasOf(state, ctx.content, id);
  const look = state.characters[id]?.extra?.look ?? ctx.content.npcs[id]?.look ?? "";
  const opening = `${josa(alias, "과/와")} 마주쳤다. 이름은 모른다.`;
  if ((state.beliefs[state.playerId] ?? []).some((b) => b.fact.startsWith(opening))) return;
  const fact = `${opening}${look ? ` 겉모습: ${look}` : ""}`;
  addBeliefTo(ctx, state.playerId, fact, "seen");
}

function addBeliefTo(ctx: ToolContext, characterId: string, fact: string, source: "seen" | "report") {
  const s = ctx.store.getState();
  ctx.store.append({
    type: "belief_added",
    characterId,
    belief: { id: `b_${s.nextBeliefNo}`, fact, source, accuracy: "exact", learnedAt: s.time },
  });
}

/** GM 상태에 넣는 틀 목록 (고를 수 있는 것) */
export function describeExtraTemplates(state: GameState, content: Content): string {
  // 지금 여기서 마주칠 만한 틀만 (appears, 기획서 7.10). 연고 틀처럼 이야기로만 생기는 것은 appears.zones: []로 숨긴다
  const zone = state.playerZone;
  const owner = zone ? (state.zones[zone]?.owner ?? null) : null;
  const mine = state.characters[state.playerId]?.factionId ?? "";
  const ownerKind = owner === null ? "none" : owner === mine ? "own" : "other";
  const segment = segmentOf(state.time);
  const list = Object.values(content.extras).filter((t) => {
    const a = t.appears;
    // 외딴곳에는 그곳을 직접 적은 틀만
    if (zone && content.locations[zone]?.isolated) return !!a?.zones?.includes(zone);
    if (!a) return true;
    if (a.zones && (!zone || !a.zones.includes(zone))) return false;
    if (a.zone_owner && !a.zone_owner.includes(ownerKind)) return false;
    if (a.segments && !a.segments.includes(segment)) return false;
    return true;
  });
  if (list.length === 0) return "";
  return `엑스트라 틀 (지금 여기서 마주칠 만한 사람. 이름 없는 인물이 주인공과 엮이면 spawn_extra로 만든다. 이야기에 붙잡을 사람이면 promote_extra):\n${list.map((t) => `- ${t.id}: ${t.label}`).join("\n")}`;
}
