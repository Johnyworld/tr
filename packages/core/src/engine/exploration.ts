import { stakesOf } from "../rules/stakes.ts";
import { heldOf } from "../rules/held.ts";
import { isInfected } from "../game/kinds.ts";
import { activeMissionOf } from "../game/missions.ts";
import { z } from "zod";
import type { Content, StoryletEffect } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import type { CheckOutcome, Difficulty } from "../rules/check.ts";
import { moveOf } from "../scenario/scenario.ts";
import { josa } from "../text.ts";
import { advanceTime } from "./action.ts";
import { rollPlayerCheck } from "./checks.ts";
import { EXTRA_TOOLS } from "./extras.ts";
import { kindOf } from "../game/kinds.ts";
import { isIncapacitated } from "./body.ts";
import { applyEffect } from "./storyletTools.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";
import { formatTime } from "../rules/time.ts";

/**
 * 탐험할 곳 (기획서 4.7.1, 12-162). 잠입 장면(9.5.1)과 같은 틀: 상태와 판정은 코드, 연출은 GM.
 * - 구역마다 숨은 곳(exploration.ruins)이 있다. 그 구역을 뒤지다 수색이 성공하면 찾는다 (대가 있는 성공은 낌새만, 12-220). 찾은 것은 그 캐릭터만 안다 (원칙 4)
 * - 깊이 칸을 판정(move)으로 한 칸씩 내려가고, 칸마다 한 번 뒤진다(search_move). 깊을수록 좋은 것이 나온다 (칸마다 찾을 거리 표)
 * - 소음(0~3)은 세계의 진짜 상태다. 숫자는 GM도 모르고 낌새로만 안다. 3에 닿으면 깊이만큼 감염체가 깨어나 장면에 들어온다
 * - 실패하면 무너진 바닥·녹슨 철근에 다친다 (판정의 대가)
 */

const rules = (content: Content) => content.scenario.exploration;
const NOISE_MAX = 3;

type Ruin = NonNullable<Content["scenario"]["exploration"]>["ruins"][number];

export function ruinOf(content: Content, id: string): Ruin | undefined {
  return rules(content)?.ruins.find((r) => r.id === id);
}

/** 이 캐릭터가 아는 이 구역의 숨은 곳 */
export function knownRuinsHere(content: Content, state: GameState): Ruin[] {
  const known = new Set(state.ruinsFound?.[state.playerId] ?? []);
  return (rules(content)?.ruins ?? []).filter((r) => r.zone === state.playerZone && known.has(r.id));
}

/** 수색 판정 뒤 (12-220): 이 구역에 아직 모르는 숨은 곳이 있으면 성공이면 찾고, 대가 있는 성공이면 낌새만 준다. 알릴 줄 */
export function findRuin(ctx: ToolContext, outcome: CheckOutcome | null): string | null {
  const r = rules(ctx.content);
  const state = ctx.store.getState();
  if (!r || !state.playerZone) return null;
  const known = new Set(state.ruinsFound?.[state.playerId] ?? []);
  const hidden = r.ruins.filter((x) => x.zone === state.playerZone && !known.has(x.id));
  const ruin = hidden[0];
  if (!ruin || (outcome !== "success" && outcome !== "partial")) return null;
  if (outcome === "partial") return "이 근처에 아직 찾지 못한 곳이 있는 것 같다. 제대로 뒤지면(수색 성공) 찾을 수 있다. 낌새만 서술한다.";
  ctx.store.append({ type: "ruin_found", characterId: state.playerId, ruin: ruin.id });
  ctx.store.append({
    type: "belief_added",
    characterId: state.playerId,
    belief: { id: `b_${ctx.store.getState().nextBeliefNo}`, fact: `${ctx.content.locations[ruin.zone]?.name ?? ruin.zone}에 숨은 곳이 있다: ${ruin.label}. ${ruin.hint}`, source: "seen", accuracy: "exact", learnedAt: state.time },
  });
  return `뒤지다가 숨은 곳을 찾았다: ${ruin.label} (${ruin.hint}). 들어가려면 explore start.`;
}

/** 소음을 낌새로 (2 이상만) */
function noiseCue(noise: number): string | null {
  if (noise >= NOISE_MAX) return "어둠 저편에서 무언가 깨어나 이쪽으로 온다";
  if (noise === 2) return "멀리서 긁는 소리가 났다가 멎는다. 무언가 귀를 기울이는 것 같다";
  return null;
}

function step(ctx: ToolContext, search = false): ToolDisplayEvent[] {
  const minutes = rules(ctx.content)?.step_minutes ?? 15;
  if (search) {
    // 뒤지기는 수색이다: 수색 시간을 채우는 임무면 그 시간으로 센다 (플레이 테스트 13)
    const state = ctx.store.getState();
    const m = activeMissionOf(state.missions, state.playerId);
    const forMission = m?.requirements.some((r) => "activity" in r && r.activity === "search") ? m.id : null;
    return advanceTime(ctx, "search", null, forMission, 1, null, "search", minutes).extra;
  }
  return advanceTime(ctx, "brief", null, null, minutes / 5).extra;
}

/** 소음을 올린다. 3에 처음 닿으면 깊이만큼 감염체가 장면에 들어온다 */
function raiseNoise(ctx: ToolContext, by: number): string[] {
  const state = ctx.store.getState();
  const ex = state.exploration!;
  const noise = Math.min(NOISE_MAX, ex.noise + by);
  ctx.store.append({ type: "exploration_changed", depth: ex.depth, noise, searched: ex.searched });
  if (noise < NOISE_MAX || ex.noise >= NOISE_MAX) return [];
  const r = rules(ctx.content)!;
  const template = r.wake[Math.min(ex.depth, r.wake.length - 1)]!;
  const spawn = EXTRA_TOOLS.find((t) => t.name === "spawn_extra")!.run as (i: { template: string; label: string }, c: ToolContext) => ToolOutcome;
  const lines = ["소리에 깨어난 것들이 온다."];
  for (let i = 0; i <= ex.depth; i++) {
    const out = spawn({ template, label: ctx.content.extras[template]?.label ?? "감염체" }, ctx);
    if (out.ok) lines.push(out.resultText);
  }
  return lines;
}

function difficultyAt(depth: number, last: number): Difficulty {
  return depth >= last ? "hard" : "normal";
}

/** 칸의 찾을 거리 표에서 n번 굴린다 */
function rollLoot(ctx: ToolContext, ruin: Ruin, depth: number, rolls: number): StoryletEffect[] {
  const table = ruin.loot[Math.min(depth, ruin.loot.length - 1)] ?? [];
  const total = table.reduce((n, i) => n + i.weight, 0);
  const effects: StoryletEffect[] = [];
  for (let r = 0; r < rolls && total > 0; r++) {
    let pick = ctx.rng() * total;
    const entry = table.find((i) => (pick -= i.weight) < 0) ?? table[table.length - 1]!;
    const [min, max] = entry.qty;
    effects.push({ give_item: { item: entry.item, quantity: min + Math.floor(ctx.rng() * (max - min + 1)) } } as StoryletEffect);
  }
  return effects;
}

const explore = defineTool({
  name: "explore",
  description:
    "숨은 곳 탐험 (잠입 장면과 같은 틀). 수색하다 찾은 숨은 곳(상태의 '아는 숨은 곳')에 들어가 칸마다 내려가고 뒤진다. 결과는 시스템이 정한다. " +
    "start(ruin): 들어간다. deeper: 한 칸 더 내려간다 (판정, 실패하면 다친다). search: 지금 칸을 뒤진다 (칸마다 한 번, 깊을수록 좋은 것). leave: 나온다 (소리가 났으면 판정, 실패하면 깨어난 것이 출구까지 따라붙는다). " +
    "걸음마다 시간이 흐르고 소리가 난다. 소음 숫자는 GM도 모른다: 상태의 '탐험 중'에 나온 낌새로만 연출한다. 소리가 쌓이면 감염체가 깨어난다. " +
    "판정은 이 도구가 굴린다: take_action으로 따로 판정하지 않는다. 이 구역에 아는 숨은 곳이 하나면 start의 ruin은 null이어도 된다.",
  schema: z.strictObject({
    action: z.enum(["start", "deeper", "search", "leave"]),
    ruin: z.string().nullable().default(null).describe("start일 때 숨은 곳 id. 아니면 null"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const r = rules(content);
    if (!r) return { ok: false, error: "이 월드에는 탐험 규칙이 없다." };
    const state = store.getState();
    const me = state.characters[state.playerId]!;
    if (heldOf(me)) return { ok: false, error: "갇힌 몸이다." };
    if (state.infiltration) return { ok: false, error: "잠입 중이다." };
    const display: ToolDisplayEvent = { type: "time", activityLabel: "탐험", durationLabel: `${r.step_minutes}분`, fromLabel: "", toLabel: "" };
    const ex = state.exploration;

    if (input.action === "start") {
      if (ex) return { ok: false, error: "이미 탐험 중이다." };
      if (state.battle) return { ok: false, error: "전투 중이다." };
      // 아는 숨은 곳이 하나면 null로도 그곳에 들어간다 (12-240, A6)
      const known = knownRuinsHere(content, state);
      const ruin = known.find((x) => x.id === input.ruin) ?? (input.ruin === null && known.length === 1 ? known[0] : undefined);
      if (!ruin) {
        const here = knownRuinsHere(content, state);
        return { ok: false, error: here.length ? `이 구역의 아는 숨은 곳: ${here.map((x) => `${x.id}(${x.label})`).join(", ")}` : "이 구역에서 아는 숨은 곳이 없다. 먼저 수색한다." };
      }
      store.append({ type: "exploration_started", ruin: ruin.id });
      // 들어간 결과에 할 수 있는 것을 함께 (12-240, A6: 할 수 있는 것을 보려고 get_scene을 따로 불렀다)
      return { ok: true, resultText: `${ruin.label}에 들어간다. 지금은 ${ruin.depths[0]}. 한 칸씩 연출하라.\n할 수 있는 것: deeper(한 칸 더 내려간다, 판정) · search(지금 칸을 뒤진다, 칸마다 한 번) · leave(나온다). 걸음마다 ${r.step_minutes}분쯤 흐른다.`, display };
    }
    if (!ex) return { ok: false, error: "탐험 중이 아니다. start로 들어간다." };
    const ruin = ruinOf(content, ex.ruin)!;
    if (state.playerZone !== ruin.zone) {
      store.append({ type: "exploration_ended" });
      return { ok: false, error: "그곳을 떠났다. 탐험은 끝났다." };
    }
    const last = ruin.depths.length - 1;
    const label = (d: number) => ruin.depths[Math.min(d, last)]!;
    const finish = (lines: string[], extra: ToolDisplayEvent[], shown: ToolDisplayEvent) => {
      const cue = noiseCue(store.getState().exploration?.noise ?? 0);
      // 흐른 시간을 함께 (12-240, A6: 탐험에 든 시간이 보이지 않았다)
      const clock = `(지금 ${formatTime(store.getState().time)}, ${josa(label(store.getState().exploration?.depth ?? 0), "이다/다")})`;
      return { ok: true as const, resultText: [...lines, ...(cue ? [`낌새: ${cue}`] : []), clock, "이 결과대로 서술하라."].join("\n"), display: shown, extra };
    };

    // 깨어난 감염체가 장면에 있으면 더 들어가거나 뒤지지 못한다: 싸우거나(take_action) 빠져나온다(leave)
    const awake = state.scene.present.filter((id) => {
      const c = state.characters[id];
      return !!c && !c.dead && kindOf(content, c) === "infected" && !isIncapacitated(content, c);
    });
    if ((input.action === "deeper" || input.action === "search") && awake.length) {
      return { ok: false, error: `깨어난 것들이 바로 앞에 있다 (${awake.join(", ")}). 먼저 싸우거나(take_action, target) 빠져나온다(leave).` };
    }

    if (input.action === "deeper") {
      if (state.battle) return { ok: false, error: "전투 중이다. 먼저 싸우거나 물러난다." };
      if (ex.depth >= last) return { ok: false, error: `이미 가장 깊은 곳(${label(last)})이다.` };
      const m = moveOf(content.scenario, r.move)!;
      const check = rollPlayerCheck({ move: r.move, stat: m.stats[0]!, difficulty: difficultyAt(ex.depth + 1, last), intent: `${josa(label(ex.depth + 1), "으로/로")} 내려간다` }, ctx, { stakes: stakesOf({ activity: true }) });
      if (!check.ok) return check;
      const extra = step(ctx);
      const lines: string[] = [];
      if (check.outcome !== "miss") {
        store.append({ type: "exploration_changed", depth: ex.depth + 1, noise: ex.noise, searched: ex.searched });
        lines.push(`${josa(label(ex.depth + 1), "으로/로")} 내려갔다.`);
        if (check.outcome === "partial") lines.push(...raiseNoise(ctx, 1));
      } else {
        lines.push(`${josa(label(ex.depth + 1), "으로/로")} 가는 길에서 일이 틀어졌다 (${ruin.hazard}). 아직 ${label(ex.depth)}.`);
        const hurt = applyEffect(ctx, { wound: { steps: 1, cause: ruin.hazard } } as StoryletEffect, {}, {}, ruin.hazard);
        if (hurt.line) lines.push(hurt.line);
        if (hurt.display) extra.push(hurt.display);
        lines.push(...raiseNoise(ctx, 1));
      }
      return finish(lines, extra, check.display);
    }

    if (input.action === "search") {
      if (state.battle) return { ok: false, error: "전투 중이다." };
      if (ex.searched.includes(ex.depth)) return { ok: false, error: `${josa(label(ex.depth), "은/는")} 이미 뒤졌다. 더 내려가거나 나온다.` };
      const m = moveOf(content.scenario, r.search_move)!;
      const check = rollPlayerCheck({ move: r.search_move, stat: m.stats[0]!, difficulty: "normal", intent: `${josa(label(ex.depth), "을/를")} 뒤진다` }, ctx, { stakes: stakesOf({ activity: true }) });
      if (!check.ok) return check;
      const extra = step(ctx, true);
      const now = store.getState().exploration!;
      store.append({ type: "exploration_changed", depth: now.depth, noise: now.noise, searched: [...now.searched, now.depth] });
      const rolls = check.outcome === "success" ? 2 : check.outcome === "partial" ? 1 : 0;
      // 같은 물건은 합쳐 적는다 (플레이 테스트 13: "붕대 ×1, 붕대 ×2를 찾았다")
      const found = new Map<string, number>();
      for (const effect of rollLoot(ctx, ruin, ex.depth, rolls)) {
        const out = applyEffect(ctx, effect, {}, {}, `탐험: ${ruin.label}`);
        if (out.display) extra.push(out.display);
        if ("give_item" in effect) found.set(effect.give_item.item, (found.get(effect.give_item.item) ?? 0) + effect.give_item.quantity);
      }
      const names = [...found].map(([id, q]) => `${content.items[id]?.name ?? id} ×${q}`);
      const lines = [names.length ? `${label(ex.depth)}에서 ${josa(names.join(", "), "을/를")} 찾았다 (소지품에 들어왔다). 찾은 것만 서술한다.` : `${label(ex.depth)}에서 쓸 만한 것을 찾지 못했다.`];
      if (check.outcome !== "success") lines.push(...raiseNoise(ctx, 1));
      return finish(lines, extra, check.display);
    }

    // leave: 조용하면 판정 없이, 소리가 났으면 깊이만큼 어렵다.
    // 실패하면 다치는 대신 깨어난 것이 출구까지 따라붙는다 (플레이 테스트 13: 선언하지 않은 피해로 치명상까지 갔다). 다치는지는 그다음 맞서기·달아나기의 판정이 정한다
    const extra = step(ctx);
    // 따라붙지 않은 감염체는 안에 두고 나온다 (플레이 테스트 13: 탐험에서 깨어난 것들이 나온 뒤에도 장면에 남았다)
    const leaveBehind = (): string[] => {
      const s = store.getState();
      const inside = s.scene.present.filter((id) => isInfected(content, s.characters[id]) && !s.companions.includes(id));
      for (const id of inside) store.append({ type: "npc_left", npcId: id });
      return inside.length ? ["깨어났던 것들은 안에 두고 나왔다."] : [];
    };
    if (ex.noise < 2) {
      const left = leaveBehind();
      store.append({ type: "exploration_ended" });
      return { ok: true, resultText: [`${ruin.label}에서 나왔다. 탐험은 끝났다.`, ...left].join("\n"), display, extra };
    }
    const m = moveOf(content.scenario, r.move)!;
    const check = rollPlayerCheck({ move: r.move, stat: m.stats[0]!, difficulty: ex.depth >= last ? "hard" : "normal", intent: "서둘러 빠져나온다" }, ctx, { stakes: stakesOf({ activity: true }) });
    if (!check.ok) return check;
    const lines = [`${ruin.label}에서 빠져나왔다. 탐험은 끝났다.`];
    if (check.outcome === "miss") {
      // 아직 깨어난 것이 없으면 이제 깨어난다 (탐험이 끝나기 전에)
      const awakeNow = store.getState().scene.present.some((id) => isInfected(content, store.getState().characters[id]));
      const woke = awakeNow ? [] : raiseNoise(ctx, NOISE_MAX);
      lines.splice(0, 1, `${ruin.label}의 출구까지 깨어난 것이 따라붙었다.`, ...woke, "출구 앞에서 마주친 장면으로 연출하고, 맞서거나 달아나는 판정(take_action, 몸의 위험을 선언)으로 이어 간다.");
    } else lines.push(...leaveBehind());
    store.append({ type: "exploration_ended" });
    return { ok: true, resultText: [...lines, "이 결과대로 서술하라."].join("\n"), display: check.display, extra };
  },
});

export const EXPLORATION_TOOLS = [explore] as const;

/** GM 상태의 "탐험 중" 블록, 아닐 때는 이 구역의 아는 숨은 곳 한 줄 */
export function describeExploration(content: Content, state: GameState): string[] {
  const r = rules(content);
  if (!r) return [];
  const ex = state.exploration;
  if (!ex) {
    const here = knownRuinsHere(content, state);
    if (!here.length || state.battle || state.infiltration) return [];
    return [`이 구역의 아는 숨은 곳 (explore start, 플레이어가 들어가겠다고 할 때만): ${here.map((x) => `${x.id} ${x.label}`).join(" / ")}`];
  }
  const ruin = ruinOf(content, ex.ruin);
  if (!ruin) return [];
  const last = ruin.depths.length - 1;
  const cue = noiseCue(ex.noise);
  const can = [ex.depth < last ? "deeper" : null, ex.searched.includes(ex.depth) ? null : "search", "leave"].filter(Boolean).join(" · ");
  return [
    `탐험 중: ${ruin.label} — 지금 ${ruin.depths[ex.depth]} (${ex.depth + 1}/${ruin.depths.length})${ex.searched.includes(ex.depth) ? ", 이 칸은 뒤졌다" : ""}`,
    `  낌새: ${cue ?? "들리는 것은 내 숨소리와 물 떨어지는 소리뿐이다"}`,
    `  할 수 있는 것 (explore): ${can}. 분위기: ${ruin.mood}`,
  ];
}
