import { stakesOf } from "../rules/stakes.ts";
import { onSpotted } from "../rules/consequence.ts";
import { heldOf, heldSeenZone } from "../rules/held.ts";
import { currentPlace, depthAt, nearestRoad, placeById, placesAtDepth } from "../rules/place.ts";
import { josa } from "../text.ts";
import { z } from "zod";
import type { Content, StoryletEffect } from "../content/schemas.ts";
import { hasMet, playerCalls } from "../game/acquaintance.ts";
import type { GameState } from "../game/state.ts";
import type { Difficulty } from "../rules/check.ts";
import { segmentOf } from "../rules/time.ts";
import { moveOf } from "../scenario/scenario.ts";
import { weatherNow } from "../sim/weather.ts";
import { advanceTime } from "./action.ts";
import { capturePlayer } from "./captivity.ts";
import { rollPlayerCheck } from "./checks.ts";
import { missionForCheck } from "../game/missions.ts";
import { recordDeed } from "./reputationTools.ts";
import { applyEffect, hostileZone, runTagEvent } from "./storyletTools.ts";
import { roadStorylets } from "../story/storylets.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 잠입 장면 (기획서 9.5.1, 12-154). 전투 장면(9.5)과 같은 틀: 상태와 판정은 코드, 연출은 GM.
 * - 깊이(depths 칸)를 은밀 판정으로 한 칸씩 들어가고, 깊은 곳에서 목표를 하고, 빠져나온다
 * - 경보(0~3)는 세계의 진짜 상태다 (원칙 4). 판정 결과는 보이지만 경보 숫자는 GM에게도 가지 않고, 보이고 들리는 낌새로만 안다 (2 이상).
 *   살피기(listen)로 대략 안다
 * - 경보 3이면 들켰다: 빠지기만 된다. 그 무리와 사이가 나빠지고 행적이 남는다. 빠지다 실패하면 그 무리에 붙잡힌다
 */

const rules = (content: Content) => content.scenario.infiltration;
const ALARM_MAX = 3;

/** 낮에는 어렵고, 밤이나 시야가 나쁜 날씨(비·안개)에는 쉽다 */
function stealthDifficulty(content: Content, state: GameState, harder = 0): Difficulty {
  const seg = segmentOf(state.time);
  const visibility = weatherNow(content.scenario, state)?.visibility ?? 1;
  let step = seg === "morning" || seg === "day" ? 1 : seg === "night" || visibility <= 0.6 ? -1 : 0;
  step += harder;
  return step <= -1 ? "easy" : step === 0 ? "normal" : step === 1 ? "hard" : "very_hard";
}

/** 잠입을 시작할 수 있는 곳: 다른 무리의 땅 (그 무리가 주인) */
function ownerHere(state: GameState): string | null {
  const zone = state.playerZone;
  const owner = zone ? (state.zones[zone]?.owner ?? null) : null;
  const me = state.characters[state.playerId];
  return owner && me && owner !== me.factionId ? owner : null;
}

/** 그 구역에 그 무리가 가둔 사람 (우리 무리 사람이 먼저) */
function captiveHere(state: GameState, zone: string, owner: string): string | null {
  const me = state.characters[state.playerId]!;
  // 캐릭터가 여기 갇혀 있다고 아는 포로만: 그곳에서 봤거나 소식으로 안 사람 (공통 규칙 15의 장소 목록과 같은 규칙)
  // (플레이 테스트 12: 담 밖에서 "갇힌 사람 풀어 주기"가 바로 떴다. 12-265, PT18 졸병: 행방 모르는 우리 무리 사람이 목표로 드러났다)
  const list = Object.values(state.characters).filter((c) => !c.dead && heldOf(c) && heldOf(c)!.by === owner && heldOf(c)!.zone === zone && c.id !== me.id && heldSeenZone(state, c.id) === zone);
  list.sort((a, b) => Number(b.factionId === me.factionId) - Number(a.factionId === me.factionId) || a.id.localeCompare(b.id));
  return list[0]?.id ?? null;
}

/** 경보를 보이고 들리는 낌새로 (2 이상만. 0·1은 아무것도 보이지 않는다) */
function alarmCue(alarm: number): string | null {
  if (alarm >= ALARM_MAX) return "들켰다. 고함과 불빛이 이쪽으로 온다";
  if (alarm === 2) return "경비가 두리번거리고, 누가 손전등을 켰다 끈다 (낌새를 챈 것 같다)";
  return null;
}


/** 판정이 임무로 셌으면 한 줄 (12-265, PT17·PT18 졸병: act에만 붙고 숨어들기·살피기·빠져나오기에는 없었다) */
function missionNote(ctx: ToolContext, missionId: string | null | undefined): string[] {
  return missionId ? [`(임무 "${ctx.store.getState().missions[missionId]?.title ?? missionId}"의 요건과 맞는 판정이라 임무로 셌다)`] : [];
}

/** 한 걸음의 시간 */
function step(ctx: ToolContext): ToolDisplayEvent[] {
  const minutes = rules(ctx.content)?.step_minutes ?? 10;
  return advanceTime(ctx, "brief", null, null, minutes / 5).extra;
}

/** 경보를 올린다. 3에 닿으면 들킨 일(그 무리와의 사이, 행적)을 남긴다 */
function raiseAlarm(ctx: ToolContext, by: number): string[] {
  const state = ctx.store.getState();
  const inf = state.infiltration!;
  const alarm = Math.min(ALARM_MAX, inf.alarm + by);
  ctx.store.append({ type: "infiltration_changed", depth: inf.depth, alarm, done: inf.done });
  if (alarm < ALARM_MAX || inf.alarm >= ALARM_MAX) return [];
  applyEffect(ctx, { faction_relation: { from: "zone_owner", to: "own", delta: -1, mutual: false } } as StoryletEffect, {}, {}, "잠입하다 들켰다");
  // 들킨 결과는 공통 규칙 3 (침입 행적, 들키지 않기 임무)
  onSpotted(ctx, inf.owner);
  // 들킨 순간은 경보 이야기로 넘긴다: 달아날지 둘러댈지 항복할지 고른다 (플레이 테스트 12: 들키면 빠지기 판정 하나로 곧바로 포로가 됐다)
  // 열 경보 이야기가 없으면 잠입 안에서 빠지기만 남는다
  const rule = ctx.content.scenario.alarm;
  const now = ctx.store.getState();
  if (rule && !now.activeStorylet && roadStorylets({ ...now, infiltration: null }, ctx.content, rule.tag, now.time, { pacing: false }).length) {
    ctx.store.append({ type: "infiltration_ended", how: "caught" });
    for (const d of runTagEvent(ctx, rule.tag)) if (d.type === "storylet" && d.event === "started") return [`들켰다: "${d.title}". 잠입은 끝났다. 그 장면으로 이어 연출하라 (상태의 '진행 중인 이야기').`];
  }
  return ["들켰다. 이제 빠지기(leave)만 할 수 있다."];
}

/** 목표의 효과를 이야기 효과로 바꿔 적용한다 (zone_owner = 그 땅의 주인) */
function goalEffects(content: Content, goalId: string, captive: string | null, half: boolean): StoryletEffect[] {
  const goal = rules(content)!.goals.find((g) => g.id === goalId)!;
  const cut = (n: number) => (half ? Math.trunc(n / 2) : n);
  const effects: StoryletEffect[] = [];
  for (const [item, n] of Object.entries(goal.items)) if (cut(n) > 0) effects.push({ give_item: { item, quantity: cut(n) } } as StoryletEffect);
  for (const [resource, delta] of Object.entries(goal.resource)) if (cut(delta) !== 0) effects.push({ faction_resource: { faction: "zone_owner", resource, delta: cut(delta) } } as StoryletEffect);
  if (goal.morale && !half) effects.push({ faction_morale: { faction: "zone_owner", delta: goal.morale } } as StoryletEffect);
  if (goal.release && captive) effects.push({ npc_release: { who: "captive" } } as StoryletEffect);
  if (goal.overhear) effects.push({ overhear: { faction: "zone_owner", source: "seen" } } as StoryletEffect);
  return effects;
}

/**
 * 잠입으로 숨어들 다음 깊이의 장소 (B③). 장소가 없는 구역이면 null(깊이만 센다), 고를 수 없으면 오류 글.
 * 갇힌 사람 풀어 주기는 가장 깊은 곳이 가두는 곳이다
 */
function nextPlace(state: GameState, content: Content, depth: number, goalId: string, asked: string | null): { id: string; name: string } | null | string {
  const here = currentPlace(state, content);
  if (depthAt(state, content) === null || !here) return null;
  const goal = rules(content)!.goals.find((g) => g.id === goalId);
  // 이웃으로 닿는 곳만 (장소 개편): 지금 깊이의 장소를 따라 숨어 가다(담 밖 둘레길 → 초소) 닿는 한 칸 더 깊은 장소.
  // 가두는 곳은 갇힌 사람 풀어 주기일 때만
  const near = new Set(frontier(state, content, here.id, depth - 1));
  const options = placesAtDepth(state, content, depth).filter((p) => near.has(p.id) && (!p.jail || !!goal?.release));
  if (!options.length) return null;
  const list = options.map((p) => `${p.id}(${p.name})`).join(", ");
  if (asked) {
    const hit = options.find((p) => p.id === asked);
    if (!hit) return `${placeById(state, content, asked)?.name ?? asked}에는 지금 숨어들 수 없다. 다음 깊이의 장소: ${list} (시간은 흐르지 않았다).`;
    return hit;
  }
  if (options.length === 1) return options[0]!;
  return `어디로 숨어들지 place로 고른다: ${list} (시간은 흐르지 않았다).`;
}

/** 지금 깊이(depth)의 장소를 따라 닿는 곳의 이웃 (잠입으로 숨어들 수 있는 곳) */
function frontier(state: GameState, content: Content, from: string, depth: number): string[] {
  const seen = new Set([from]);
  const queue = [from];
  const out = new Set<string>();
  while (queue.length) {
    const at = queue.shift()!;
    for (const n of placeById(state, content, at)?.near ?? []) {
      out.add(n);
      if (!seen.has(n) && depthAt(state, content, n) === depth) { seen.add(n); queue.push(n); }
    }
  }
  return [...out];
}

/** 빠져나오면 가장 가까운 길로 (B③, 장소 개편) */
function backToEntry(ctx: ToolContext): void {
  const here = currentPlace(ctx.store.getState(), ctx.content);
  const road = nearestRoad(ctx.store.getState(), ctx.content);
  if (here && road && road !== here.id) ctx.store.append({ type: "place_moved", from: here.id, to: road });
}

const infiltrate = defineTool({
  name: "infiltrate",
  description:
    "잠입 장면 (전투 장면과 같은 틀). 다른 무리의 땅에서 몰래 들어가 목표를 하고 나온다. 결과는 시스템이 정한다. " +
    "start(goal): 시작한다 (지금 장소의 깊이에서: 담 있는 구역은 담을 지나기 전 = 담 밖, 담 문(gate) = 담 안, 그 너머 = 깊은 곳. 담 없는 구역은 길에서 몇 칸). advance(place): 한 칸 더 깊은 이웃 장소로 숨어든다 (은밀 판정). " +
    "act: 가장 깊은 곳에서 목표를 한다. listen: 멈춰서 낌새를 살핀다 (들켰는지 대략 안다). leave: 빠져나온다 (가장 가까운 길로). 잠입 중에는 take_action.place_to로 옮기지 않는다. " +
    "한 번에 한 걸음, 걸음마다 시간이 흐른다. 경보 숫자는 GM도 모른다: 상태의 '잠입 중'에 나온 낌새로만 연출한다. 들키면 빠지기만 된다. " +
    "판정은 이 도구가 굴린다: take_action으로 따로 판정하지 않는다 (12-240: 따로 굴린 은밀 판정이 헛것이 됐다).",
  schema: z.strictObject({
    action: z.enum(["start", "advance", "act", "listen", "leave"]),
    goal: z.string().nullable().default(null).describe("start일 때 목표 id (상태의 '잠입할 수 있는 목표'). 아니면 null"),
    place: z.string().nullable().default(null).describe("advance일 때 숨어들 장소 id (상태의 '잠입 중'에 나온 다음 깊이의 장소). 하나뿐이거나 갇힌 사람 풀어 주기의 가두는 곳이면 null로 둔다"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const r = rules(content);
    if (!r) return { ok: false, error: "이 월드에는 잠입 규칙이 없다." };
    const state = store.getState();
    const me = state.characters[state.playerId]!;
    if (heldOf(me)) return { ok: false, error: "갇힌 몸이다." };
    if (state.battle) return { ok: false, error: "전투 중이다." };
    const display: ToolDisplayEvent = { type: "time", activityLabel: "잠입", durationLabel: `${r.step_minutes}분`, fromLabel: "", toLabel: "" };
    const inf = state.infiltration;
    const depthLabel = (d: number) => r.depths[Math.min(d, r.depths.length - 1)]!;
    const deepest = r.depths.length - 1;

    if (input.action === "start") {
      if (inf) return { ok: false, error: "이미 잠입 중이다." };
      const owner = ownerHere(state);
      if (!owner) return { ok: false, error: "다른 무리의 땅에서만 잠입한다." };
      const goal = r.goals.find((g) => g.id === input.goal);
      if (!goal) return { ok: false, error: `목표: ${r.goals.map((g) => `${g.id}(${g.label})`).join(", ")}` };
      if (goal.release && !captiveHere(state, state.playerZone!, owner)) return { ok: false, error: "이 구역에는 그 무리가 가둔 사람이 없다 (캐릭터가 아는 한)." };
      store.append({ type: "infiltration_started", zone: state.playerZone!, owner, goal: goal.id });
      // 지금 장소의 깊이에서 시작한다 (B③, 공통 규칙 15 depthAt: 수용소 안에서 시작해도 "담 밖"이었다)
      const from = depthAt(state, content) ?? 0;
      if (from > 0) store.append({ type: "infiltration_changed", depth: from, alarm: 0, done: false });
      return { ok: true, resultText: `잠입을 시작했다: ${content.factions[owner]?.name ?? owner}의 ${content.locations[state.playerZone!]?.name ?? state.playerZone} — 목표: ${goal.label}. 지금은 ${depthLabel(from)}. 한 걸음씩 연출하라.`, display };
    }
    if (!inf) return { ok: false, error: "잠입 중이 아니다. start로 시작한다." };
    if (state.playerZone !== inf.zone) {
      store.append({ type: "infiltration_ended", how: "gone" });
      return { ok: false, error: "잠입하던 곳을 떠났다. 잠입은 끝났다." };
    }
    const caught = inf.alarm >= ALARM_MAX;
    if (caught && input.action !== "leave") return { ok: false, error: "들켰다. 빠지기(leave)만 할 수 있다." };

    if (input.action === "advance") {
      if (inf.depth >= deepest) return { ok: false, error: `이미 가장 깊은 곳(${depthLabel(deepest)})이다. act로 목표를 한다.` };
      // 장소가 있는 구역이면 다음 깊이의 장소로 숨어든다: 잠입 깊이와 지금 장소가 늘 같다 (B③)
      const next = nextPlace(state, content, inf.depth + 1, inf.goal, input.place);
      if (typeof next === "string") return { ok: false, error: next };
      const m = moveOf(content.scenario, r.move)!;
      const advanceMission = missionForCheck(ctx.store.getState(), r.move);
      const check = rollPlayerCheck({ move: r.move, stat: m.stats[0]!, difficulty: stealthDifficulty(content, state), intent: `${josa(depthLabel(inf.depth + 1), "으로/로")} 숨어든다` }, ctx, { stakes: stakesOf({ exposed: true }), forMission: advanceMission });
      if (!check.ok) return check;
      const extra = step(ctx);
      const lines: string[] = [];
      // 낌새가 쌓인 데서 대가 있는 성공이면 들키지 않고 한 걸음 물러난다: 대가 있는 성공이 곧 들킴이 되지 않게 (플레이 테스트 13)
      const wouldBeCaught = check.outcome === "partial" && inf.alarm + 1 >= ALARM_MAX;
      if (wouldBeCaught) {
        lines.push(`${josa(depthLabel(inf.depth + 1), "으로/로")} 가려다 발소리가 가까워 한 걸음 물러나 숨었다. 들키지는 않았다. 아직 ${depthLabel(inf.depth)} (낌새가 짙다: 한 번 더 어긋나면 들킨다).`);
      } else if (check.outcome !== "miss") {
        store.append({ type: "infiltration_changed", depth: inf.depth + 1, alarm: inf.alarm, done: inf.done });
        if (next) store.append({ type: "place_moved", from: currentPlace(store.getState(), content)?.id ?? null, to: next.id });
        lines.push(`${josa(depthLabel(inf.depth + 1), "으로/로")} 들어갔다${next ? `: ${next.name}` : ""}.`);
        if (check.outcome === "partial") lines.push(...raiseAlarm(ctx, 1));
      } else {
        lines.push(`${josa(depthLabel(inf.depth + 1), "으로/로")} 가는 길을 찾지 못했다. 아직 ${depthLabel(inf.depth)}.`);
        lines.push(...raiseAlarm(ctx, 2));
      }
      lines.push(...missionNote(ctx, advanceMission));
      const cue = alarmCue(store.getState().infiltration?.alarm ?? 0);
      return { ok: true, resultText: [...lines, ...(cue ? [`낌새: ${cue}`] : []), "이 결과대로 서술하라."].join("\n"), display: check.display, extra };
    }

    if (input.action === "listen") {
      const m = moveOf(content.scenario, r.listen)!;
      const check = rollPlayerCheck({ move: r.listen, stat: m.stats[0]!, difficulty: "normal", intent: "멈춰서 낌새를 살핀다" }, ctx, { stakes: stakesOf({ exposed: true }), forMission: missionForCheck(ctx.store.getState(), r.listen) });
      if (!check.ok) return check;
      const extra = step(ctx);
      const alarm = store.getState().infiltration!.alarm;
      const exact = ["아무도 모른다", "누군가 고개를 갸웃했다 (아직 찾지는 않는다)", "낌새를 챘다. 찾기 시작했다", "들켰다"][alarm]!;
      const rough = alarm >= 2 ? "공기가 달라졌다. 무언가 눈치챈 것 같다" : "아직은 조용한 것 같다";
      const sensed = check.outcome === "success" ? exact : check.outcome === "partial" ? rough : "아무것도 알 수 없었다";
      return { ok: true, resultText: `살폈다: ${sensed}. 이 결과대로 서술하라.`, display: check.display, extra };
    }

    if (input.action === "act") {
      if (inf.depth < deepest) return { ok: false, error: `목표는 가장 깊은 곳(${depthLabel(deepest)})에서 한다. 지금은 ${depthLabel(inf.depth)}.` };
      if (inf.done) return { ok: false, error: "목표는 이미 했다. 빠져나온다." };
      const goal = r.goals.find((g) => g.id === inf.goal)!;
      const m = moveOf(content.scenario, goal.move)!;
      const goalMission = missionForCheck(ctx.store.getState(), goal.move);
      const check = rollPlayerCheck({ move: goal.move, stat: m.stats[0]!, difficulty: stealthDifficulty(content, state), intent: goal.label }, ctx, { stakes: stakesOf({ exposed: true }), forMission: goalMission });
      if (!check.ok) return check;
      const extra = step(ctx);
      const lines: string[] = [];
      if (goalMission) lines.push(`(임무 "${ctx.store.getState().missions[goalMission]?.title ?? goalMission}"의 요건과 맞는 판정이라 임무로 셌다)`);
      if (check.outcome !== "miss") {
        const captive = captiveHere(store.getState(), inf.zone, inf.owner);
        for (const effect of goalEffects(content, goal.id, captive, check.outcome === "partial")) {
          const out = applyEffect(ctx, effect, captive ? { captive } : {}, {}, `잠입: ${goal.label}`);
          if (out.line) lines.push(out.line);
          if (out.display) extra.push(out.display);
        }
        // 풀어 준 사람과는 얼굴을 마주했다: 만난 사이가 되고 고마워한다 (12-262, PT16·PT17 졸병: "아직 직접 만나 본 적이 없다")
        if (captive && goal.release) {
          // 얼굴을 마주했으니 아는 마음(perceived)도 갱신한다: 같은 무리 사람은 처음부터 met이라 들고 나기를 건너뛰었다 (12-265, PT18 졸병)
          const s1 = store.getState();
          if (!hasMet(s1, s1.playerId, captive) && !s1.scene.present.includes(captive) && !s1.characters[captive]?.dead) {
            store.append({ type: "npc_entered", npcId: captive });
            store.append({ type: "npc_left", npcId: captive });
          }
          store.append({ type: "relation_changed", from: captive, to: s1.playerId, delta: { trust: 2, affection: 2, respect: 0 }, reason: "갇힌 곳에서 꺼내 줬다", known: true });
        }
        const now = store.getState().infiltration!;
        store.append({ type: "infiltration_changed", depth: now.depth, alarm: now.alarm, done: true });
        lines.unshift(`${goal.label}: 해냈다${check.outcome === "partial" ? " (다 하지는 못했다)" : ""}.${captive && goal.release ? ` ${josa(playerCalls(store.getState(), content, captive), "을/를")} 풀어 냈다.` : ""}`);
        // 대가 있는 성공은 들킴이 아니다: 낌새가 짙어도 들키기 직전에서 멈춘다 (플레이 테스트 13)
        if (check.outcome === "partial" && now.alarm + 1 >= ALARM_MAX) lines.push("들킬 뻔했다. 숨을 죽여 넘겼다 (낌새가 짙다: 한 번 더 어긋나면 들킨다).");
        else if (check.outcome === "partial") lines.push(...raiseAlarm(ctx, 1));
      } else {
        lines.push(`${goal.label}: 하지 못했다.`);
        lines.push(...raiseAlarm(ctx, 2));
      }
      const cue = alarmCue(store.getState().infiltration?.alarm ?? 0);
      // 목표의 판정은 손에 잡히는 일이라 보인다 (들켰는지는 따로 낌새로)
      return { ok: true, resultText: [...lines, ...(cue ? [`낌새: ${cue}`] : []), "이 결과대로 서술하라."].join("\n"), display: check.display, extra };
    }

    // leave: 들키지 않았으면 판정 없이, 아니면 깊이와 경보만큼 어렵다
    const extra = step(ctx);
    if (inf.alarm === 0) {
      store.append({ type: "infiltration_ended", how: "out" });
      backToEntry(ctx);
      return { ok: true, resultText: "아무도 모르게 빠져나왔다. 잠입은 끝났다.", display, extra };
    }
    const m = moveOf(content.scenario, r.move)!;
    const harder = (inf.depth >= deepest ? 1 : 0) + (caught ? 1 : 0);
    const leaveMission = missionForCheck(ctx.store.getState(), r.move);
    const check = rollPlayerCheck({ move: r.move, stat: m.stats[0]!, difficulty: stealthDifficulty(content, state, harder), intent: "빠져나온다" }, ctx, { stakes: stakesOf({ exposed: true }), forMission: leaveMission });
    if (!check.ok) return check;
    store.append({ type: "infiltration_ended", how: check.outcome === "miss" ? "caught" : "out" });
    if (check.outcome !== "miss") backToEntry(ctx);
    const counted = missionNote(ctx, leaveMission).map((l) => ` ${l}`).join("");
    if (check.outcome === "success") return { ok: true, resultText: `빠져나왔다. 잠입은 끝났다.${counted} 이 결과대로 서술하라.`, display: check.display, extra };
    if (check.outcome === "partial") {
      return { ok: true, resultText: `빠져나왔지만 아슬아슬했다: 등 뒤로 고함이 쫓아왔다 (얼굴을 봤을지 모른다). 잠입은 끝났다.${counted} 이 결과대로 서술하라.`, display: check.display, extra };
    }
    const taken = capturePlayer(ctx, inf.owner, inf.zone, "잠입하다 붙잡혔다");
    return { ok: true, resultText: `빠져나오지 못했다. ${taken ?? "붙잡혔다."} 이 결과대로 서술하라.`, display: check.display, extra };
  },
});

export const INFILTRATION_TOOLS = [infiltrate] as const;

/** GM 상태의 "잠입 중" 블록, 잠입하지 않을 때는 다른 무리의 땅이면 할 수 있는 목표 한 줄 */
export function describeInfiltration(content: Content, state: GameState): string[] {
  const r = rules(content);
  if (!r) return [];
  const inf = state.infiltration;
  if (!inf) {
    const owner = ownerHere(state);
    // 갇혀 있으면 잠입할 수 없다 (플레이 테스트 12: 갇힌 상태 화면에 잠입 목표가 떴다)
    // 적대하는 땅에서만 보인다 (플레이 테스트 13: 연합·중립 거점에도 잠입 목표가 떴다). 그 밖에서도 플레이어가 먼저 숨어들겠다고 하면 할 수는 있다
    if (!owner || state.battle || heldOf(state.characters[state.playerId]) || !hostileZone(state, content)) return [];
    const goals = r.goals.filter((g) => !g.release || captiveHere(state, state.playerZone!, owner));
    return [`잠입할 수 있는 목표 (infiltrate start, 플레이어가 몰래 들어가겠다고 할 때만): ${goals.map((g) => `${g.id} ${g.label}`).join(" / ")}`];
  }
  const goal = r.goals.find((g) => g.id === inf.goal);
  const deepest = r.depths.length - 1;
  const cue = alarmCue(inf.alarm);
  const can = inf.alarm >= ALARM_MAX ? "leave" : [inf.depth < deepest ? "advance" : null, inf.depth >= deepest && !inf.done ? "act" : null, "listen", "leave"].filter(Boolean).join(" · ");
  const here = currentPlace(state, content);
  const near = new Set(here ? frontier(state, content, here.id, inf.depth) : []);
  const ahead = inf.depth < deepest && inf.alarm < ALARM_MAX ? placesAtDepth(state, content, inf.depth + 1).filter((p) => near.has(p.id) && (!p.jail || !!goal?.release)) : [];
  return [
    `잠입 중: ${content.factions[inf.owner]?.name ?? inf.owner}의 ${content.locations[inf.zone]?.name ?? inf.zone} — 지금 ${r.depths[inf.depth]} (${inf.depth + 1}/${r.depths.length}), 목표: ${goal?.label ?? inf.goal}${inf.done ? " (해냈다)" : ""}`,
    `  낌새: ${cue ?? "보이고 들리는 이상한 것은 없다 (들켰는지는 모른다)"}`,
    `  할 수 있는 것 (infiltrate): ${can}. 장면 밖으로 옮기거나 오래 쉬지 않는다 (place_to 대신 advance·leave)`,
    ...(ahead.length ? [`  다음 깊이의 장소 (advance place): ${ahead.map((p) => `${p.id} ${p.name}`).join(" / ")}`] : []),
  ];
}
