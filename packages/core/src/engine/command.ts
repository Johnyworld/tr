import { heldOf } from "../rules/held.ts";
import { seasonAt } from "../sim/season.ts";
import { stockOutlook } from "../sim/war.ts";
import { effectiveSkill } from "./traits.ts";
import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { roleOf, type GameState } from "../game/state.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import { fill as fillText, josa } from "../text.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { CHECK_OUTCOME_LABELS, roll2d6, type CheckOutcome } from "../rules/check.ts";
import { dayOf, formatTime, MINUTES_PER_DAY } from "../rules/time.ts";
import { HOSTILE, disposition, factionPolicy } from "../sim/war.ts";
export { factionPolicy };
import { changeCondition } from "./body.ts";
import { rollPlayerCheck } from "./checks.ts";
import { gainMeritXp } from "./growth.ts";
import { baseOf } from "./captivity.ts";
import { LEAVE_AT } from "./companionTools.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 지휘 (기획서 9.11): 분대 명령과 지도부 회의.
 * - 분대원이 따르는지, 맡긴 일의 결과, 무리 방침의 효과는 모두 코드가 정한다 (원칙 2)
 * - 주인공은 화면 밖 일의 결과를 돌아온 분대원의 보고로만 안다 (원칙 4)
 */

type Scenario = Content["scenario"];
type SquadTask = NonNullable<Scenario["command"]>["squad_tasks"][number];

/** 분대 보고 표시의 제목 머리 (GM 문장에서 임무와 구분한다) */
export const SQUAD_REPORT_PREFIX = "분대 보고: ";

/** 존중이 이 값 이하면 명령을 거절한다 */
const REFUSE_AT = -2;
/** 존중이 이 값이면 늦게 나간다 (시간 ×1.5) */
const SLOW_AT = -1;
/** 기각된 안은 이 시간 동안 다시 올리지 못한다 */
const COUNCIL_BLOCK_MINUTES = 3 * MINUTES_PER_DAY;

/** 주인공의 분대원: 역할의 squad 중 살아 있고, 떠나지 않았고, 붙잡히지 않았고, 같은 무리인 사람 */
/**
 * 주인공이 분대원일 때 같은 분대 (분대장 commander + 역할의 squad_mates). 명령은 내리지 못하고 보기만 한다.
 * 그 자리(계급)·무리에 있을 때만. 죽거나 떠나거나 붙잡힌 사람은 빠진다
 */
export function squadOf(state: GameState, content: Content): { leader: string | null; mates: string[] } | null {
  const role = roleOf(content, state);
  const player = state.characters[state.playerId];
  if (!role?.squad_mates?.length || !player?.factionId || player.rank !== role.rank || player.factionId !== role.faction) return null;
  const here = (id: string) => {
    const c = state.characters[id];
    return !!c && id !== state.playerId && !c.dead && !c.away && !heldOf(c) && c.factionId === player.factionId;
  };
  const leader = role.commander && here(role.commander) ? role.commander : null;
  const mates = role.squad_mates.filter(here);
  return leader || mates.length ? { leader, mates } : null;
}

export function squadMembers(state: GameState, content: Content): string[] {
  const role = roleOf(content, state);
  const player = state.characters[state.playerId];
  // 진급해서 꾸린 분대 (12-190)
  if (state.squad && player?.factionId) {
    return state.squad.filter((id) => {
      const c = state.characters[id];
      return id !== state.playerId && !!c && !c.dead && !c.away && !heldOf(c) && c.factionId === player.factionId;
    });
  }
  // 그 자리(계급)에 있는 사람만 분대를 지휘한다. 분대원이 이어받아 플레이하면 분대장이 아니다
  if (!role?.squad?.length || !player?.factionId || player.rank !== role.rank) return [];
  return role.squad.filter((id) => {
    if (id === state.playerId) return false;
    const c = state.characters[id];
    return c && !c.dead && !c.away && !heldOf(c) && c.factionId === player.factionId;
  });
}

/** 지금 일을 나가 있어 장면·배역에 나올 수 없는 사람 */
export function isOnSquadOrder(state: Pick<GameState, "squadOrders">, id: string): boolean {
  return !!state.squadOrders?.[id];
}

/** 주인공이 지도부 회의에 앉는지 */
export function sitsOnCouncil(state: GameState, content: Content): boolean {
  const player = state.characters[state.playerId];
  const c = content.scenario.command;
  return !!player?.factionId && !!c?.policies.length && c.council_ranks.includes(player.rank);
}

/** 구역 위험 보정: 우리 땅 0, 빈 땅 -1, 그 밖(남의 땅) -2 */
export function zoneRisk(state: GameState, content: Content, zone: string): number {
  const owner = state.zones[zone]?.owner ?? null;
  const mine = state.characters[state.playerId]?.factionId ?? "";
  if (owner && owner === mine) return 0;
  if (!owner) return -1;
  return mine && disposition(content, mine, owner, state) > HOSTILE ? -1 : -2;
}

const taskOf = (content: Content, id: string): SquadTask | undefined => content.scenario.command?.squad_tasks.find((t) => t.id === id);
const zoneName = (content: Content, id: string) => content.locations[id]?.name ?? id;

export const squadOrder = defineTool({
  name: "squad_order",
  description:
    "분대장 이상: 분대원에게 일을 맡긴다 (기획서 9.11). 분대원이 장면에 있거나 주인공이 거점에 있을 때만. " +
    "따르는지와 결과는 코드가 정한다: 나간 분대원은 정한 시간 동안 장면에서 빠지고, 끝나면 보고가 돌아온다. 결과를 미리 서술하지 않는다. " +
    "task는 GM 상태의 '분대' 섹션에 나온 일 id. follow는 곁에 두기(동행), rest는 쉬게 하기.",
  schema: z.strictObject({
    members: z.array(z.string().min(1)).min(1).max(8).describe("분대원 id"),
    task: z.string().min(1).describe("일 id (분대 섹션의 목록)"),
    zone: z.string().nullable().describe("나가서 하는 일이면 구역 id. 아니면 null"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const task = taskOf(content, input.task);
    if (!task) return { ok: false, error: `없는 일: ${input.task} (가능: ${(content.scenario.command?.squad_tasks ?? []).map((t) => t.id).join(", ") || "없음"})` };
    const squad = squadMembers(state, content);
    if (!squad.length) return { ok: false, error: "지휘할 분대가 없다. 분대 명령은 분대를 맡은 사람만 내린다." };
    const role = roleOf(content, state);
    // 무리 거점도 거점이다 (플레이 테스트 11: 시작 구역이 물류창고인 역할은 붉은연합 거점에서도 "장면에 없다"였다)
    const home = state.characters[state.playerId]?.factionId ? baseOf(content, state.characters[state.playerId]!.factionId) : undefined;
    const atBase = (!!role?.start_location && state.playerZone === role.start_location) || (!!home && state.playerZone === home);
    let zone = state.playerZone ?? role?.start_location ?? "";
    if (task.needs_zone) {
      if (!input.zone || !content.locations[input.zone]) return { ok: false, error: `${task.label}에는 구역이 필요하다 (zone). 구역 id: ${Object.keys(content.locations).join(", ")}` };
      zone = input.zone;
    }
    // 명령할 수 없는 사람은 건너뛰고 나머지는 처리한다 (플레이 테스트 11: 하나가 오류면 아무도 움직이지 않았다)
    const skipped: string[] = [];
    const why = (id: string): string | null => {
      if (!squad.includes(id)) return `${josa(id, "은/는")} 분대원이 아니다 (분대원: ${squad.join(", ")}).`;
      if (isOnSquadOrder(state, id)) return `${josa(playerCalls(state, content, id), "은/는")} 이미 일을 나가 있다 (${formatTime(state.squadOrders[id]!.until)}에 돌아온다).`;
      if (!state.scene.present.includes(id) && !atBase) return `${josa(playerCalls(state, content, id), "이/가")} 장면에 없다. 거점이 아니면 곁에 있는 분대원에게만 명령한다.`;
      if (task.kind === "follow" && state.companions.includes(id)) return `${josa(playerCalls(state, content, id), "은/는")} 이미 곁에 있다.`;
      // 믿음이 바닥난 분대원은 곁에 붙자마자 떠났다 (플레이 테스트 11): 처음부터 따르지 않는다
      if (task.kind === "follow" && (state.relations[id]?.[state.playerId] ?? NEUTRAL_RELATION).trust <= LEAVE_AT) return `${josa(playerCalls(state, content, id), "은/는")} 당신을 믿지 않아 곁에 붙으려 하지 않는다 (신뢰가 바닥이다).`;
      return null;
    };
    const members = [...new Set(input.members)].filter((id) => {
      const problem = why(id);
      if (problem) skipped.push(problem);
      return !problem;
    });
    if (members.length === 0) return { ok: false, error: skipped.join(" ") };

    const lines: string[] = skipped.map((p) => `건너뜀: ${p}`);
    const displays: ToolDisplayEvent[] = [];
    for (const id of members) {
      const name = playerCalls(state, content, id);
      const respect = (state.relations[id]?.[state.playerId] ?? NEUTRAL_RELATION).respect;
      if (respect <= REFUSE_AT) {
        store.append({ type: "squad_order_refused", npcId: id, task: task.id });
        lines.push(`${josa(name, "은/는")} 명령을 따르지 않았다 (${task.label}). 분대장을 우습게 본다. 거절하는 모습을 서술한다.`);
        displays.push({ type: "presence", npcName: `${name} · 명령 거절`, action: "leave" });
        continue;
      }
      if (task.kind === "follow") {
        store.append({ type: "companion_joined", characterId: id, kind: "squad" });
        lines.push(`${josa(name, "이/가")} 곁에 붙는다 (동행. 구역을 옮겨도 따라온다).`);
        displays.push({ type: "presence", npcName: name, action: "enter" });
        continue;
      }
      const slow = respect <= SLOW_AT ? 1.5 : 1;
      const minutes = Math.round(task.hours * 60 * slow);
      const until = state.time + minutes;
      store.append({ type: "squad_order_given", npcId: id, task: task.id, zone, until });
      lines.push(
        `${josa(name, "이/가")} ${task.needs_zone ? `${josa(zoneName(content, zone), "으로/로")} ` : ""}${task.label}에 나선다. ${formatTime(until)}쯤 끝난다${slow > 1 ? " (투덜대며 늑장을 부린다)" : ""}. 결과는 코드가 정하고, 끝나면 보고가 온다.`,
      );
      displays.push({ type: "presence", npcName: `${name} · ${task.label}`, action: "leave" });
    }
    const [first, ...rest] = displays;
    return { ok: true, resultText: lines.join("\n"), display: first!, extra: rest };
  },
});

/** 끝난 분대 명령의 결과를 굴린다 (시간이 흐른 뒤 코드가 하는 일) */
export function runSquadOrders(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const displays: ToolDisplayEvent[] = [];
  const due = Object.entries(store.getState().squadOrders ?? {})
    .filter(([, o]) => o.until <= store.getState().time)
    .sort(([a, x], [b, y]) => x.until - y.until || a.localeCompare(b));
  for (const [id, order] of due) {
    const state = store.getState();
    const npc = state.characters[id];
    const task = taskOf(content, order.task);
    const player = state.characters[state.playerId];
    if (!npc || !task || !player) {
      store.append({ type: "squad_order_done", npcId: id, task: order.task, outcome: null, report: "" });
      continue;
    }
    const name = playerCalls(state, content, id);
    const zone = zoneName(content, order.zone);
    const fill = (t: string) => fillText(t, { member: name, zone });

    if (npc.dead || heldOf(npc) || npc.away) {
      // 그사이 다른 일로 돌아오지 못했다. 주인공은 돌아오지 않았다는 것만 안다
      store.append({ type: "squad_order_done", npcId: id, task: task.id, outcome: null, report: `${josa(name, "이/가")} ${task.label}에서 돌아오지 않았다.` });
      displays.push({ type: "mission", event: "expired", title: `${SQUAD_REPORT_PREFIX}${name} · ${task.label}`, detail: "돌아오지 않음" });
      continue;
    }

    if (task.kind === "rest") {
      changeCondition(ctx, id, content.scenario.harm_track, -1, "쉼", "분대장이 쉬게 했다");
      store.append({ type: "relation_changed", from: id, to: state.playerId, delta: { trust: 0, affection: 1, respect: 0 }, reason: "분대장이 쉬게 해 주었다" });
      store.append({ type: "squad_order_done", npcId: id, task: task.id, outcome: null, report: fill(task.report.success) });
      continue;
    }

    // 2d6 + 능력 + 스킬(상한) + 구역 위험 + 지휘
    const s = content.scenario;
    const move = s.moves.find((m) => m.id === task.move);
    const stat = task.stat ?? move?.stats[0] ?? "";
    const ability = npc.stats[stat] ?? 0;
    const skill = move ? effectiveSkill(content, npc, move.id) : 0;
    const leadSkill = s.command?.lead_skill;
    const lead = leadSkill && effectiveSkill(content, player, leadSkill) >= 1 ? 1 : 0;
    const roll = roll2d6(rng, Math.min(s.ranges.cap, ability + skill) + zoneRisk(state, content, order.zone) + lead);
    const outcome: CheckOutcome = roll.outcome;

    const lines: string[] = [];
    if (outcome !== "miss") {
      const half = outcome === "partial";
      for (const [r, amount] of Object.entries(task.rewards.resources)) {
        const n = half ? Math.floor(amount / 2) : amount;
        if (n > 0 && player.factionId) store.append({ type: "faction_resource_changed", factionId: player.factionId, resource: r, delta: n });
      }
      if (task.rewards.loot) {
        const loot = content.locations[order.zone]?.loot;
        // 전리품은 성공일 때만 (12-220, 숨은 확률 대신 판정 결과)
        if (loot?.items.length && !half) {
          const total = loot.items.reduce((n, i) => n + i.weight, 0);
          let pick = rng() * total;
          const entry = loot.items.find((i) => (pick -= i.weight) < 0) ?? loot.items.at(-1)!;
          store.append({ type: "item_granted", to: state.playerId, itemId: entry.item, quantity: entry.qty[0] });
          lines.push(`${content.items[entry.item]?.name ?? entry.item} ×${josa(String(entry.qty[0]), "을/를")} 가져왔다`);
        }
      }
      // 데려온 사람 (12-140): 무리의 입과 손이 함께 는다
      const people = half ? Math.floor(task.rewards.population / 2) : task.rewards.population;
      if (people > 0 && player.factionId) {
        store.append({ type: "faction_population_changed", factionId: player.factionId, delta: people });
        lines.push(`떠돌던 사람 ${people}명을 데려와 무리에 들였다`);
      }
      const merit = half ? Math.floor(task.rewards.merit / 2) : task.rewards.merit;
      if (merit > 0) {
        store.append({ type: "merit_awarded", characterId: state.playerId, delta: merit, reason: `분대: ${task.label}` });
        // 공적이 바뀌면 까닭과 함께 알린다 (플레이 테스트 13: 공적이 말없이 올랐다)
        lines.push(`분대가 해낸 일로 공적 +${merit}`);
        const levelUp = gainMeritXp(ctx, state.playerId, merit);
        if (levelUp) lines.push(levelUp);
      }
      if (task.dangerous && !half) {
        store.append({ type: "relation_changed", from: id, to: state.playerId, delta: { trust: 0, affection: 0, respect: 1 }, reason: "위험한 일을 맡기고 해냈다" });
      }
    } else {
      if (task.dangerous) changeCondition(ctx, id, s.harm_track, 1, "분대 명령", `${task.label} 중 다침`);
      store.append({ type: "relation_changed", from: id, to: state.playerId, delta: { trust: -1, affection: 0, respect: 0 }, reason: "분대장이 맡긴 일이 틀어졌다" });
      lines.push("일이 틀어져 분대장을 믿는 마음이 조금 줄었다");
    }

    const after = store.getState().characters[id]!;
    const report = after.dead
      ? `${josa(name, "이/가")} ${zone}에서 ${task.label} 중에 돌아오지 않았다.`
      : [fill(task.report[outcome]), ...lines].join(" · ");
    store.append({ type: "squad_order_done", npcId: id, task: task.id, outcome: after.dead ? null : outcome, report });
    displays.push({ type: "mission", event: "reported", title: `${SQUAD_REPORT_PREFIX}${name} · ${task.label}`, detail: after.dead ? "돌아오지 않음" : CHECK_OUTCOME_LABELS[outcome] });
  }
  return displays;
}

export const councilPropose = defineTool({
  name: "council_propose",
  description:
    "간부: 지도부 회의에서 무리 방침을 바꾸자는 안을 올린다 (기획서 9.11). 상관(지도부)이 장면에 있을 때, 주제마다 하루 한 번. " +
    "판정과 결과(받아들여지는지, 반대한 사람의 신뢰)는 코드가 정한다. 바뀐 방침은 무리의 배급·공세에 코드가 반영한다. " +
    "topic·option은 GM 상태 '복무·임무'의 무리 방침 목록에서. approach는 어떻게 설득하는지 (스킬 id).",
  schema: z.strictObject({
    topic: z.string().min(1),
    option: z.string().min(1),
    approach: z.string().min(1).describe("설득에 쓰는 스킬 id (예: 교섭이나 전략)"),
    stat: z.string().min(1).describe("그 스킬에 쓰는 능력 id"),
    intent: z.string().min(1).max(200).describe("무엇을 근거로 안을 올리는지 한 줄"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const c = content.scenario.command;
    const player = state.characters[state.playerId]!;
    if (!sitsOnCouncil(state, content)) return { ok: false, error: "지도부 회의에 앉는 계급이 아니다." };
    const role = roleOf(content, state);
    const chair = role?.commander;
    if (!chair || !state.scene.present.includes(chair)) return { ok: false, error: "회의를 여는 상관이 장면에 없다. 먼저 npc_presence로 들인다." };
    const topic = c!.policies.find((p) => p.id === input.topic);
    if (!topic) return { ok: false, error: `없는 주제: ${input.topic} (가능: ${c!.policies.map((p) => p.id).join(", ")})` };
    const option = topic.options.find((o) => o.id === input.option);
    if (!option) return { ok: false, error: `없는 선택지: ${input.option} (가능: ${topic.options.map((o) => o.id).join(", ")})` };
    const faction = state.factions[player.factionId];
    const current = factionPolicy(content, faction).find((p) => p.topic.id === topic.id)?.option;
    if (current?.id === option.id) return { ok: false, error: `이미 그 방침이다 (${topic.label}: ${option.label}).` };
    const today = dayOf(state.time);
    const log = state.council[topic.id];
    if (log && log.day === today) return { ok: false, error: `${josa(topic.label, "은/는")} 오늘 이미 안을 올렸다.` };
    if (log && state.time < log.blockedUntil) return { ok: false, error: `${topic.label} 안은 기각됐다. ${formatTime(log.blockedUntil)} 뒤에 다시 올릴 수 있다.` };
    if (!c!.council_moves.includes(input.approach)) return { ok: false, error: `회의에서 쓰는 스킬이 아니다 (가능: ${c!.council_moves.join(", ")})` };

    // 상관이 나를 믿으면 쉽고, 못 믿으면 어렵다
    const trust = (state.relations[chair]?.[state.playerId] ?? NEUTRAL_RELATION).trust;
    const difficulty = trust >= 2 ? "easy" : trust <= -2 ? "hard" : "normal";
    const check = rollPlayerCheck({ move: input.approach, stat: input.stat, difficulty, intent: input.intent }, ctx);
    if (!check.ok) return check;
    const outcome = check.outcome;
    const blockedUntil = outcome === "miss" ? state.time + COUNCIL_BLOCK_MINUTES : state.time;
    store.append({ type: "council_proposed", topic: topic.id, option: option.id, outcome, day: today, blockedUntil });
    const chairName = playerCalls(state, content, chair);
    const lines: string[] = [];
    if (outcome === "miss") {
      lines.push(`${josa(chairName, "이/가")} 안을 받아들이지 않았다 (${topic.label}: ${option.label}). 사흘 동안 같은 주제를 다시 올리지 못한다.`);
    } else {
      store.append({ type: "faction_policy_set", factionId: player.factionId, topic: topic.id, option: option.id });
      lines.push(`안이 받아들여졌다. 무리 방침 ${topic.label}: ${current?.label ?? "?"} → ${option.label}. ${option.summary}`);
      if (outcome === "partial") {
        for (const who of option.opposed_by) {
          // 반대하는 사람은 같은 무리의 회의에 앉은 사람만
          if (!state.characters[who] || state.characters[who]!.dead || state.characters[who]!.factionId !== player.factionId) continue;
          store.append({ type: "relation_changed", from: who, to: state.playerId, delta: { trust: -1, affection: 0, respect: 0 }, reason: `회의에서 ${option.label} 안을 밀어붙였다` });
          lines.push(`${josa(playerCalls(state, content, who), "은/는")} 끝까지 반대했고, 당신을 덜 믿게 됐다.`);
        }
      }
    }
    lines.push("회의 장면을 이 결과대로 서술한다. 숫자(창고 양, 날짜)는 지어내지 않는다.");
    return {
      ok: true,
      resultText: [`판정: ${CHECK_OUTCOME_LABELS[outcome]}`, ...lines].join("\n"),
      display: check.display,
      extra: [{ type: "mission", event: outcome === "miss" ? "abandoned" : "reported", title: `회의: ${topic.label} → ${option.label}`, detail: outcome === "miss" ? "기각" : "채택" }],
    };
  },
});

export const COMMAND_TOOLS = [squadOrder, councilPropose] as const;

/** GM 상태의 분대 섹션 */
export function describeSquadForGm(state: GameState, content: Content): string {
  const squad = squadMembers(state, content);
  const tasks = content.scenario.command?.squad_tasks ?? [];
  const role = roleOf(content, state);
  const player = state.characters[state.playerId];
  if (!player) return "";
  // 진급해서 꾸린 분대 (12-190)가 있으면 그것, 아니면 역할의 분대 (B1, 플레이 테스트 9)
  const roster = state.squad ?? (role?.squad?.length && player.rank === role.rank && !role.squad.includes(player.id) ? role.squad : null);
  if (!roster) return "";
  const lost = roster.filter((id) => !squad.includes(id) && state.characters[id]);
  if (!squad.length && !lost.length) return "";
  const lines = [`분대 (squad_order로 일을 맡긴다. 분대원이 장면에 있거나 거점에 있을 때):`];
  for (const id of squad) {
    const o = state.squadOrders[id];
    const name = playerCalls(state, content, id);
    const doing = o
      ? `${taskOf(content, o.task)?.label ?? o.task} 중 (${zoneName(content, o.zone)}, ${formatTime(o.until)}쯤 끝남)`
      : state.companions.includes(id)
        ? "곁에 있음"
        : state.scene.present.includes(id)
          ? "장면에 있음"
          : "거점에 있음";
    const report = state.squadReports[id];
    lines.push(`- ${name} (${id}): ${doing}${report && !o ? ` · 마지막 보고: ${report.text}` : ""}`);
  }
  for (const id of lost) lines.push(`- ${playerCalls(state, content, id)} (${id}): ${state.squadReports[id]?.text ?? "분대에 없다"}`);
  if (tasks.length) lines.push(`맡길 수 있는 일: ${tasks.map((t) => `${t.id} ${t.label}${t.needs_zone ? " [구역]" : ""}${t.dangerous ? " [위험]" : ""}`).join(" / ")}`);
  return lines.join("\n");
}

/** GM 상태: 주인공 무리의 방침 (무리 사람은 누구나 안다). 회의에 앉으면 바꿀 수 있는 선택지까지 */
export function describePolicyForGm(state: GameState, content: Content): string {
  const player = state.characters[state.playerId];
  if (!player?.factionId || !content.scenario.command?.policies.length) return "";
  const list = factionPolicy(content, state.factions[player.factionId]);
  const council = sitsOnCouncil(state, content);
  const lines = [`무리 방침: ${list.map(({ topic, option }) => `${topic.label} ${option.label}`).join(" · ")}`];
  if (council) {
    lines.push(`회의 (council_propose, 상관이 장면에 있을 때 주제마다 하루 한 번, 스킬: ${content.scenario.command.council_moves.join("/")}):`);
    // 창고 전망 (12-139): 지금 방침대로면 줄어드는 자원이 며칠 가는지, 안을 바꾸면 어떻게 되는지. GM 전용 숫자: 지도부 사람이 말로 전한다
    const faction = state.factions[player.factionId]!;
    const season = seasonAt(content.scenario, state.time);
    const label = (r: string) => content.scenario.resources.find((x) => x.id === r)?.label ?? r;
    const outlook = (f: typeof faction) => stockOutlook(content, state, player.factionId, f, season);
    const now = outlook(faction);
    lines.push(
      now.length
        ? `창고 전망 (지금 방침·${season?.label ?? "이 계절"}대로, 교전·교역 빼고): ${now.map((o) => `${label(o.resource)} 약 ${o.days}일`).join(", ")}. 지도부 사람이 말로 전한다 ("이대로면 겨울을 못 넘긴다"). 숫자를 그대로 말하지 않는다`
        : `창고 전망 (지금 방침·${season?.label ?? "이 계절"}대로): 줄어드는 자원이 없다`,
    );
    for (const { topic, option } of list) {
      const blocked = state.council[topic.id];
      const note = blocked && state.time < blocked.blockedUntil ? ` (기각됨, ${formatTime(blocked.blockedUntil)}까지)` : blocked?.day === dayOf(state.time) ? " (오늘 이미 올림)" : "";
      const ahead = (o: (typeof topic.options)[number]) => {
        if (o.id === option.id) return "";
        const after = outlook({ ...faction, policy: { ...(faction.policy ?? {}), [topic.id]: o.id } });
        const changed = after.filter((a) => now.find((n) => n.resource === a.resource)?.days !== a.days || !now.some((n) => n.resource === a.resource));
        const gone = now.filter((n) => !after.some((a) => a.resource === n.resource));
        const parts = [...changed.map((a) => `${label(a.resource)} 약 ${a.days}일`), ...gone.map((n) => `${label(n.resource)} 줄지 않음`)];
        return parts.length ? ` → ${parts.join(", ")}` : "";
      };
      lines.push(`- ${topic.id} ${topic.label}: 지금 ${option.id}${note} · 선택지 ${topic.options.map((o) => `${o.id} ${o.label}(${o.summary})${ahead(o)}`).join(" / ")}`);
    }
  }
  return lines.join("\n");
}

/** 곁에 둔 분대원이 주는 판정 보정 (동행 보정과 같은 자리) */
export function squadFollowBonus(state: GameState, content: Content, move: string): number {
  const bonus = content.scenario.command?.follow_bonus[move] ?? 0;
  if (!bonus) return 0;
  const squad = new Set(squadMembers(state, content));
  return state.companions.some((id) => squad.has(id) && state.scene.present.includes(id)) ? bonus : 0;
}
