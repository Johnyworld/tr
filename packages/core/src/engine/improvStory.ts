import { z } from "zod";
import { createContentSchemas, type Content, type StoryletContent, type StoryletEffect } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { carriedCount } from "../game/companions.ts";
import { RELATION_AXES, RELATION_AXIS_LABELS } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import type { Rng } from "../rng.ts";
import { formatTime, type GameTime } from "../rules/time.ts";
import type { Scenario } from "../scenario/schema.ts";
import { moveLabel } from "../scenario/scenario.ts";
import { learned } from "../rules/skill.ts";
import { situationOf } from "../rules/situation.ts";
import { peopleAt, whereIs } from "../rules/place.ts";
import { inCrisis, isThreat, storyletGapMinutes } from "../story/storylets.ts";
import { josa } from "../text.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

/**
 * 즉흥 이야기 (12-247, 기획서 10.5.5).
 * 여는 때는 코드가(채우기용 반복 템플릿이 골리면 그 자리를, GM은 그 사이 맞는 순간에), 이야기는 GM이(improvise_storylet), 숫자는 코드가(scenario.improv) 정한다 (원칙 2).
 * 지은 이야기는 진행 중인 이야기(activeStorylet.improvised)가 되어 resolve_storylet으로 그대로 푼다
 */

export const IMPROV_ID_PREFIX = "improv_";

type Improv = NonNullable<Scenario["improv"]>;
type Tier = "none" | "small" | "medium";

/**
 * 줄거리를 움직이는 효과 (12-247): 이런 효과가 있는 이야기는 즉흥으로 바꾸지 않는다.
 * 즉흥 이야기는 이 효과를 만들 수 없으니, 바꾸면 다짐·무리 일·사람의 사연이 멈춘다
 */
const PLOT_EFFECTS = new Set([
  "set_flag", "clear_flag", "clock", "faction_relation", "faction_policy", "faction_resource", "faction_morale", "join_faction", "expel", "player_rank", "npc_rank",
  "resolve", "resolve_step", "capture_player", "release_player", "send_to", "agenda", "mission_goal", "npc_depart", "locate", "clear_bounty", "settle_vendetta",
  "reveal_tie", "grudge", "end_romance", "end_blackmail", "fortify", "cultivate", "disaster_prepare",
]);

/** 줄거리 몫이 있는 이야기인가: 다짐·플래그·장례·재난·계승의 조건, 이어지는 배역(keep·recall), 줄거리 효과 */
export function hasPlotRole(s: StoryletContent): boolean {
  const w = s.when;
  if (w.resolve || w.flags_all || w.flags_any || w.funeral || w.disaster || w.predecessor_here) return true;
  if (Object.values(s.cast).some((r) => ("keep" in r && r.keep !== undefined) || ("recall" in r && r.recall !== undefined))) return true;
  return s.choices.some((c) => [...c.effects, ...Object.values(c.outcomes ?? {}).flat()].some((e) => Object.keys(e).some((k) => PLOT_EFFECTS.has(k))));
}

/** 이 이야기를 여는 대신 즉흥 이야기 자리를 열까: 채우기용 반복 템플릿이고(앞 즉흥 자리 뒤에 쓰인 이야기가 한 편 열린 뒤), 세계의 위험(급한 것·위협·임무 자리·갇힌 동안)도 줄거리 몫도 아니고, 앞 자리와 떨어졌을 때 */
export function shouldImprovise(state: GameState, content: Content, s: StoryletContent, at: GameTime): boolean {
  const rule = content.scenario.improv;
  if (!rule || !s.repeatable || s.urgent || s.essential || s.bedside || s.when.mission || isThreat(content, s) || hasPlotRole(s)) return false;
  // 깨어 있을 때만 (공통 규칙 4: 갇힘·누움·탐험·잠입·전투·위협 앞은 그 처지의 이야기 몫)
  const captivity = content.scenario.captivity?.tag;
  if (situationOf(state, content) !== "awake" || (captivity && s.tags.includes(captivity))) return false;
  // 쓰인 이야기와 번갈아 (12-306, PT28 세 판: seen_times 0이라 처음 뽑힌 이야기가 줄줄이 즉흥 자리로 바뀌었다.
  // 1로 올리면 쉬는 날이 긴 반복 이야기를 두 번 보기 어려워 즉흥 자리가 거의 안 열린다): 앞 즉흥 자리(없으면 판의 시작) 뒤에 쓰인 이야기가 한 편 열린 뒤에만
  const since = state.lastImprovSlotAt ?? -Infinity;
  if (!Object.values(state.storyletLog).some((l) => l.lastFiredAt > since)) return false;
  // 곁에 쓸 사람(장면·동행, 또는 이 장소에 있을 사람)이 없으면 즉흥 자리 대신 쓰인 이야기를 연다 (12-307, PT28~30 세 회차: 혼자일 때 열려 사람을 지어 들이거나 쓰지 못했다)
  if (!castable(state).length && !peopleHere(state, content)) return false;
  return state.lastImprovSlotAt === null || at - state.lastImprovSlotAt >= rule.gap_hours * 60;
}

/**
 * 즉흥 이야기 자리를 연다. 이야기 사이 간격도 센다 (state의 improv_slot_opened).
 * 자리는 열린 이야기와 같은 기한(expire_hours)만큼 열려 있다: GM이 장면에 맞는 순간을 고른다. 쓰지 않고 지나가면 간격을 잡지 않는다 (PT23)
 */
export function openImprovSlot(ctx: ToolContext): ToolDisplayEvent[] {
  const state = ctx.store.getState();
  ctx.store.append({ type: "improv_slot_opened", expiresAt: state.time + Math.round(ctx.content.scenario.storylet_pacing.expire_hours * 60) });
  return [{ type: "storylet", event: "improv", title: "즉흥 이야기 자리", detail: "GM이 장면에 맞는 순간에 작은 이야기를 지을 수 있다" }];
}

/**
 * 열린 자리를 지금 쓸 수 있는가: 기한 안이고, 주인공이 깨어 있고(공통 규칙 4의 처지 awake: 갇힘·누움·탐험·잠입·전투·위협 앞이 아니다) 위급하지 않을 때.
 * 자리는 몇 시간 열려 있어 그사이 붙잡히거나 쓰러질 수 있다 (확인 플레이: 갇혀 의식을 잃은 주인공에게 자리가 남아 있었다).
 * 막 잠에서 깬 때(누움)는 숨겨 둘 뿐 닫지 않는다: 일어나 움직이면 다시 보인다
 */
function slotUsable(state: GameState, content: Content): boolean {
  const me = state.characters[state.playerId];
  return !!state.improvSlot && state.time < state.improvSlot.expiresAt && !!me && !me.dead && situationOf(state, content) === "awake" && !inCrisis(state, content);
}

/** 자리를 닫아야 하는가: 기한이 지났거나, 깨어 있는 처지로 돌아올 수 없는 일(죽음·갇힘·위급)이 생겼다 */
function slotDead(state: GameState, content: Content): boolean {
  const me = state.characters[state.playerId];
  if (!state.improvSlot || state.time >= state.improvSlot.expiresAt || !me || me.dead || inCrisis(state, content)) return true;
  const situation = situationOf(state, content);
  return situation === "captive" || situation === "battle";
}

/** 기한이 지났거나 더는 쓸 수 없는 자리는 닫는다 */
export function lapseImprovSlot(ctx: ToolContext): void {
  const state = ctx.store.getState();
  if (state.improvSlot && slotDead(state, ctx.content)) ctx.store.append({ type: "improv_slot_closed", unused: true });
}

/** 지금 장소에 있을 사람 수 (장면에 들이면 배역이 된다) */
function peopleHere(state: GameState, content: Content): number {
  const here = whereIs(state, content, state.playerId);
  return here?.place ? peopleAt(state, content, here.zone, here.place).filter((id) => id !== state.playerId).length : 0;
}

/** 배역으로 쓸 수 있는 사람: 지금 장면에 있거나 곁의 동행 (원칙 4: 주인공 앞에 있는 사람만) */
function castable(state: GameState): string[] {
  return [...new Set([...state.scene.present, ...state.companions])].filter((id) => {
    const c = state.characters[id];
    return !!c && id !== state.playerId && !c.dead && !c.away;
  });
}

/** GM 상태: 열린 즉흥 이야기 자리 */
export function describeImprovSlotForGm(state: GameState, content: Content): string {
  const slot = state.improvSlot;
  const rule = content.scenario.improv;
  if (!slot || !rule || state.activeStorylet || !slotUsable(state, content)) return "";
  const people = castable(state).map((id) => `${playerCalls(state, content, id)}(${id})`);
  // 곁에 사람이 없으면 한 줄만 (12-260, PT15 섬: 혼자 자는 동안 보상·대가 설명이 9시간 실렸다). 사람이 생기면 전체를 싣는다
  if (!people.length) {
    // 이 장소에 있을 사람이 있으면 부르면 된다 (12-261, PT16 졸병: 막사에 열다섯이 있는데 "곁에 사람이 없다")
    const nearby = peopleHere(state, content);
    // 보상 축은 늘 보인다 (12-307, PT30 하얀매: 사람 없이 열린 자리에서 축을 몰라 affinity로 적어 오류)
    const axes = `보상 축(reward_axis): ${RELATION_AXES.join("·")}`;
    return nearby
      ? `즉흥 이야기 자리 (${formatTime(slot.expiresAt)}까지): 장면에 사람이 없다. 이 장소에 있을 사람 ${nearby}명 가운데 누구를 npc_presence로 장면에 들이면 배역으로 쓸 수 있다. ${axes}.`
      : `즉흥 이야기 자리 (${formatTime(slot.expiresAt)}까지): 곁에 사람이 없다. 사람을 만나면(장면에 들이거나 spawn_extra) 쓸 수 있다. ${axes}.`;
  }
  const track = content.scenario.condition_tracks.find((t) => t.id === rule.costs.body.track)?.label ?? rule.costs.body.track;
  return [
    `즉흥 이야기 자리 (${formatTime(slot.expiresAt)}까지): 반복되는 이야기 대신 장면에 맞는 작은 이야기를 improvise_storylet로 지어 열 수 있다. 지금 장면이 맞지 않으면(할 일이 뚜렷하다, 막 이야기가 끝났다, 혼자 쉬는 중) 맞는 순간까지 기다렸다 써도 된다. 쓰지 않으면 지나간다.`,
    `  배역으로 쓸 수 있는 사람: ${people.join(", ")} (이 장소에 있을 사람은 npc_presence로 장면에 들이면 배역이 된다. 이름 없는 사람이 필요하면 먼저 spawn_extra)`,
    `  보상 (등급 small·medium, 숫자와 물건은 시스템이 정한다): item 물건(reward_item에 갈래: ${Object.entries(rule.item_kinds).map(([k, v]) => `${k} ${v}`).join("·")}), relation 배역의 마음(${RELATION_AXES.map((a) => `${a} ${RELATION_AXIS_LABELS[a]}`).join("·")}), merit 공적`,
    `  대가: relation 배역의 신뢰가 떨어짐, noise 이 구역에 소리, time 시간이 더 걸림, body ${track}, give 주인공이 가진 물건 하나를 내준다 (cost_item에 소지품 id: 맞바꾸기·나눠 주기·건네기. 판정 없는 선택지면 그 물건이 있어야 고를 수 있다)`,
    "  판정이 붙은 선택지는 성공=보상, 대가 있는 성공=한 등급 낮은 보상+대가, 실패=대가. 판정이 없는 선택지는 보상 small까지이고 보상이 있으면 대가도 있어야 한다.",
    "  세계를 크게 움직이는 일(무리·전황·비밀·부상·이동)은 즉흥 이야기로 만들 수 없다. 그런 일은 평소 도구로.",
  ].join("\n");
}

const choiceInput = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/).describe("선택지 id (영문 소문자, 예: help, refuse)"),
  label: z.string().min(1).max(80).describe("선택지 한 줄 (GM이 보는 이름. 플레이어에게 메뉴로 보이지 않는다)"),
  check: z.string().nullable().default(null).describe("판정 스킬 id. 판정이 없으면 null"),
  reward: z.enum(["none", "small", "medium"]).default("none").describe("보상 등급 (판정이 없으면 small까지)"),
  reward_kind: z.enum(["item", "relation", "merit"]).nullable().default(null).describe("보상 종류. reward가 none이면 null"),
  reward_item: z.string().nullable().default(null).describe("item 보상: 물건의 갈래 (상태의 '즉흥 이야기 자리'에 적힌 것). 이야기에서 나올 만한 것으로"),
  reward_who: z.string().nullable().default(null).describe("relation 보상: 마음이 오르는 배역 key"),
  // null도 받는다 (12-294, PT25·26: 다른 칸은 null이 되는데 이것만 거절됐다)
  reward_axis: z.enum(RELATION_AXES).nullable().default("trust").describe("relation 보상의 축 (null이면 trust)"),
  cost: z.enum(["none", "relation", "noise", "time", "body", "give"]).default("none").describe("대가 종류"),
  cost_item: z.string().nullable().default(null).describe("give 대가: 주인공이 내주는 소지품 id (하나)"),
  cost_who: z.string().nullable().default(null).describe("relation 대가: 신뢰가 떨어지는 배역 key"),
});
type ChoiceInput = z.infer<typeof choiceInput>;

const lower = (t: Tier): Tier => (t === "medium" ? "small" : t);

function rewardEffects(rule: Improv, c: ChoiceInput, tier: Tier, rng: Rng): StoryletEffect[] {
  if (tier === "none" || !c.reward_kind) return [];
  const r = rule.rewards[tier];
  if (c.reward_kind === "item") {
    const list = r.items[c.reward_item!]!;
    const pick = list[Math.floor(rng() * list.length)]!;
    return [{ give_item: { item: pick.item, quantity: pick.quantity } }];
  }
  if (c.reward_kind === "relation") return [{ relation: { who: c.reward_who!, axis: c.reward_axis ?? "trust", delta: r.relation, kind: "improv" } }];
  return r.merit > 0 ? [{ merit: r.merit }] : [];
}

function costEffects(rule: Improv, c: ChoiceInput): StoryletEffect[] {
  switch (c.cost) {
    case "relation":
      return [{ relation: { who: c.cost_who!, axis: "trust", delta: rule.costs.relation } }];
    case "noise":
      return [{ zone_noise: rule.costs.noise }];
    case "time":
      return [{ delay: rule.costs.time }];
    case "body":
      return [{ body: { track: rule.costs.body.track, delta: rule.costs.body.delta, chance: 1 } }];
    case "give":
      return [{ take_item: { item: c.cost_item!, quantity: 1 } }];
    default:
      return [];
  }
}

const schemaCache = new WeakMap<Scenario, ReturnType<typeof createContentSchemas>["storylet"]>();
function storyletSchema(s: Scenario) {
  let schema = schemaCache.get(s);
  if (!schema) schemaCache.set(s, (schema = createContentSchemas(s).storylet));
  return schema;
}

export const improviseStorylet = defineTool({
  name: "improvise_storylet",
  description:
    "상태에 '즉흥 이야기 자리'가 열려 있을 때만: 지금 장면에 맞는 작은 이야기를 지어 연다. 상황과 선택지 문장은 GM이 쓰고, " +
    "선택지마다 판정 스킬과 보상 등급·종류, 대가 종류만 고른다 (물건과 숫자는 시스템이 정한다). " +
    "열린 이야기는 '진행 중인 이야기'가 되고, 플레이어가 고르면 resolve_storylet으로 푼다. 보상을 미리 말하지 않는다.",
  schema: z.strictObject({
    title: z.string().min(1).max(30).describe("이야기 제목 (짧게)"),
    setup: z.string().min(1).max(400).describe("상황 (지금 장면에서 벌어지는 일. 주인공이 할 행동을 이미 한 것으로 쓰지 않는다. 보상 물건은 시스템이 고르니 무엇인지 못 박지 말고 갈래만 비친다: '먹을 것 꾸러미')"),
    cast: z
      .array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]*$/).describe("배역 key (예: stranger)"), character_id: z.string().describe("장면에 있거나 곁의 동행인 인물 id") }))
      .max(3)
      .default([]),
    choices: z.array(choiceInput).min(2).max(4),
  }),
  run(input, ctx) {
    const { store, content, rng } = ctx;
    const state = store.getState();
    const rule = content.scenario.improv;
    const slot = state.improvSlot;
    if (!rule || !slot || !slotUsable(state, content)) return { ok: false, error: "열린 즉흥 이야기 자리가 없다. 평소처럼 장면을 연출한다." };
    if (state.activeStorylet) return { ok: false, error: "진행 중인 이야기가 있다. 그것을 먼저 푼다." };
    if (state.battle) return { ok: false, error: "전투 중에는 이야기를 열 수 없다." };
    const player = state.characters[state.playerId]!;

    // 배역: 지금 주인공 앞에 있는 사람만
    const allowed = new Set(castable(state));
    const cast: Record<string, string> = {};
    for (const c of input.cast) {
      if (cast[c.key]) return { ok: false, error: `배역 key가 겹친다: ${c.key}` };
      if (!allowed.has(c.character_id)) return { ok: false, error: `${c.character_id}: 장면에 있거나 곁에 있는 사람만 배역이 될 수 있다 (가능: ${[...allowed].join(", ") || "없음"}).` };
      if (Object.values(cast).includes(c.character_id)) return { ok: false, error: `한 사람이 두 배역을 맡을 수 없다: ${c.character_id}` };
      cast[c.key] = c.character_id;
    }

    // 선택지: 보상 규칙 (원칙 2: 등급만 고르고, 공짜 보상은 없다)
    const ids = new Set<string>();
    for (const c of input.choices) {
      const where = `선택지 ${c.id}`;
      if (ids.has(c.id)) return { ok: false, error: `선택지 id가 겹친다: ${c.id}` };
      ids.add(c.id);
      if (c.check) {
        if (!content.scenario.moves.some((m) => m.id === c.check)) return { ok: false, error: `${where}: 알 수 없는 스킬 ${c.check}` };
        if (learned(content.scenario, player.skills, c.check) === null) return { ok: false, error: `${where}: 주인공이 배우지 않은 ${josa(moveLabel(content.scenario, c.check), "은/는")} 판정으로 쓸 수 없다.` };
      }
      if (c.reward !== "none" && !c.reward_kind) return { ok: false, error: `${where}: 보상 종류(reward_kind)를 고른다.` };
      if (c.reward === "none" && c.reward_kind) return { ok: false, error: `${where}: 보상이 none이면 reward_kind는 null.` };
      if (c.reward_kind === "item" && (!c.reward_item || !rule.item_kinds[c.reward_item])) return { ok: false, error: `${where}: item 보상은 물건의 갈래(reward_item)가 있어야 한다 (가능: ${Object.keys(rule.item_kinds).join(", ")}).` };
      if (c.reward_kind === "relation" && (!c.reward_who || !cast[c.reward_who])) return { ok: false, error: `${where}: relation 보상은 배역 key(reward_who)가 있어야 한다.` };
      if (c.cost === "relation" && (!c.cost_who || !cast[c.cost_who])) return { ok: false, error: `${where}: relation 대가는 배역 key(cost_who)가 있어야 한다.` };
      if (c.cost === "give" && (!c.cost_item || !content.items[c.cost_item] || carriedCount(state, c.cost_item) < 1)) return { ok: false, error: `${where}: give 대가는 주인공이 지금 가진 물건 id(cost_item)가 있어야 한다.` };
      if (!c.check && c.reward === "medium") return { ok: false, error: `${where}: 판정이 없는 선택지의 보상은 small까지다.` };
      if (!c.check && c.reward !== "none" && c.cost === "none") return { ok: false, error: `${where}: 판정 없이 보상을 받는 선택지에는 대가가 있어야 한다.` };
    }

    // 숫자는 시스템이: 등급을 효과로 (물건은 등급 목록에서 고른다)
    const choices = input.choices.map((c) => {
      const base = { id: c.id, label: c.label };
      if (!c.check) return { ...base, effects: [...rewardEffects(rule, c, c.reward, rng), ...costEffects(rule, c)] };
      return {
        ...base,
        check: c.check,
        outcomes: {
          success: rewardEffects(rule, c, c.reward, rng),
          partial: [...rewardEffects(rule, c, lower(c.reward), rng), ...costEffects(rule, c)],
          miss: costEffects(rule, c),
        },
      };
    });
    const id = `${IMPROV_ID_PREFIX}${state.time}`;
    const parsed = storyletSchema(content.scenario).safeParse({
      id,
      title: input.title,
      setup: input.setup,
      cast: Object.fromEntries(Object.entries(cast).map(([key, who]) => [key, { ids: [who], enter: false }])),
      choices,
    });
    if (!parsed.success) return { ok: false, error: `이야기를 만들 수 없다: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    store.append({
      type: "storylet_fired",
      storyletId: id,
      cast,
      expiresAt: state.time + Math.round(content.scenario.storylet_pacing.expire_hours * 60),
      improvised: parsed.data as unknown as Record<string, unknown>,
    });
    return {
      ok: true,
      resultText: `즉흥 이야기 "${input.title}"${josa(input.title, "을/를").slice(input.title.length)} 열었다. 이제 상태의 '진행 중인 이야기'다. 장면으로 연출하고, 플레이어가 고르면 resolve_storylet으로 푼다. 보상과 대가는 시스템이 정했으니 미리 말하지 않는다.`,
      display: { type: "storylet", event: "started", title: input.title, detail: input.setup },
    };
  },
});

/** 자동 플레이의 대역 (LLM이 없다): 정해 둔 작은 이야기로 자리를 채워 간격과 보상 균형만 본다 */
export function autoplayImprovInput(state: GameState, content: Content): z.input<typeof improviseStorylet.schema> {
  const who = castable(state)[0];
  const kind = Object.keys(content.scenario.improv?.item_kinds ?? {})[0] ?? null;
  return {
    title: "대역 즉흥 이야기",
    setup: "누군가 도움을 청한다.",
    cast: who ? [{ key: "asker", character_id: who }] : [],
    choices: [
      { id: "help", label: "돕는다", check: "endure", reward: "medium", reward_kind: who ? "relation" : "item", reward_item: who ? null : kind, reward_who: who ? "asker" : null, cost: "body" },
      { id: "trade", label: "대가를 받고 돕는다", check: null, reward: "small", reward_kind: "item", reward_item: kind, cost: "time" },
      { id: "leave", label: "지나친다", check: null, reward: "none", reward_kind: null, cost: "none" },
    ],
  };
}
