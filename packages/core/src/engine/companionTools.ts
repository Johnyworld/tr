import { z } from "zod";
import type { RoleContent } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { activeCompanions, bondOf } from "../game/companions.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import { formatTime } from "../rules/time.ts";
import { CHECK_OUTCOME_LABELS } from "../rules/check.ts";
import { josa } from "../text.ts";
import { rollPlayerCheck } from "./checks.ts";
import { createExtraCharacter } from "./extras.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 함께 다니는 이유와 떨어짐 (기획서 7.9). 언제 끝나는지, 갈림길의 기울기, 떠나는지는 코드가 정한다
 */

/** 갈림길에서 정하지 않으면 이만큼 뒤에 그 사람 뜻대로 된다 */
const CROSSROADS_MINUTES = 12 * 60;
/** 붙잡았는데 대가 있는 성공이면 이만큼 더 함께 간다 */
const EXTEND_MINUTES = 48 * 60;
/** 신뢰+호감이 이 이상이면 갈림길에서 남고 싶어 한다 */
const STAY_AT = 3;
/** 이 신뢰 이하면 떠난다 (연고는 KIN_LEAVE_AT) */
const LEAVE_AT = -2;
const KIN_LEAVE_AT = -3;

/** GM 문장으로 실을 동행 소식 (presence 표시의 note) */
function note(npcName: string, action: "enter" | "leave", text: string): ToolDisplayEvent {
  return { type: "presence", npcName, action, note: text };
}

/** 시간이 흐른 뒤 동행 처리: 합류, 임무 짝의 귀대, 관계가 바닥이면 떠남, 목적을 이루면 갈림길 */
export function runCompanions(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const out: ToolDisplayEvent[] = [];
  const ids = [...new Set([...store.getState().companions, ...Object.keys(store.getState().bonds ?? {})])].sort();
  for (const id of ids) {
    const state = store.getState();
    const c = state.characters[id];
    if (!c) continue;
    const name = playerCalls(state, content, id);
    if (c.dead || c.away || c.captive) {
      if (state.bonds[id] || state.companions.includes(id)) store.append({ type: "companion_left", characterId: id, reason: "함께 다닐 수 없게 됐다" });
      continue;
    }
    const bond = bondOf(state, content, id);
    if (!bond) continue;

    // 떨어져 있던 사람이 돌아온다
    if (bond.apart) {
      if (bond.apart.zone && bond.apart.zone === state.playerZone) {
        store.append({ type: "companion_rejoined", characterId: id });
        out.push(note(name, "enter", `${josa(name, "이/가")} 기다리던 ${content.locations[bond.apart.zone]?.name ?? bond.apart.zone}에서 다시 합류했다. 다시 만나는 장면을 짧게 서술한다.`));
      } else if (bond.apart.until !== null && state.time >= bond.apart.until) {
        store.append({ type: "companion_rejoined", characterId: id });
        out.push(note(name, "enter", `${josa(name, "이/가")} 볼일을 마치고 돌아와 다시 곁에 섰다. 무엇을 하고 왔는지는 지어내지 않는다 (물어보면 그 사람이 아는 만큼만).`));
      }
      continue;
    }

    // 임무 짝: 임무가 끝나면 자기 자리로
    if (bond.kind === "buddy" && (!bond.missionId || state.missions[bond.missionId]?.status !== "active")) {
      store.append({ type: "companion_left", characterId: id, reason: "임무가 끝났다" });
      out.push(note(name, "leave", `임무가 끝나 짝이던 ${josa(name, "이/가")} 자기 자리로 돌아간다.`));
      continue;
    }

    // 관계가 바닥이면 떠난다 (동물은 예외)
    const rel = state.relations[id]?.[state.playerId] ?? NEUTRAL_RELATION;
    if (bond.kind !== "animal" && rel.trust <= (bond.kind === "kin" ? KIN_LEAVE_AT : LEAVE_AT)) {
      store.append({ type: "companion_left", characterId: id, reason: "더는 믿지 않는다" });
      out.push(note(name, "leave", `${josa(name, "은/는")} 더는 당신을 믿지 않는다. 함께 다니지 않겠다며 떠난다. 떠나는 장면을 서술한다.`));
      continue;
    }

    if (bond.kind !== "purpose") continue;
    // 갈림길: 정하지 않은 채 시간이 지나면 그 사람 뜻대로
    if (bond.crossroads) {
      if (state.time < bond.crossroads.decideBy) continue;
      if (bond.crossroads.lean === "stay") {
        store.append({ type: "companion_bond_changed", characterId: id, kind: "kin" });
        out.push(note(name, "enter", `${josa(name, "은/는")} 아무 말 없이 계속 곁에 남았다. 이제 함께 다니는 사이다 (연고).`));
      } else {
        store.append({ type: "companion_left", characterId: id, reason: "자기 길을 갔다" });
        out.push(note(name, "leave", `${josa(name, "은/는")} 자기 길을 가기로 했다. 짧게 인사하고 떠나는 장면을 서술한다.`));
      }
      continue;
    }
    // 목적을 이뤘는지 (플래그, 도착, 시각)
    const u = bond.until;
    if (!u) continue;
    const flags = new Set(state.flags[state.playerId] ?? []);
    const done = (u.flag && flags.has(u.flag)) || (u.zone && state.playerZone === u.zone) || (u.at !== undefined && state.time >= u.at);
    if (!done) continue;
    const lean = rel.trust + rel.affection >= STAY_AT ? "stay" : "leave";
    store.append({ type: "companion_crossroads", characterId: id, lean, decideBy: state.time + CROSSROADS_MINUTES });
    out.push(
      note(
        name,
        "enter",
        `${josa(name, "과/와")} 함께 하기로 한 일이 끝났다 (갈림길). ${lean === "stay" ? "그 사람은 더 함께 가고 싶어 하는 눈치다" : "그 사람은 자기 길을 가려는 눈치다"}. 이 순간을 장면으로 보여 주고 플레이어의 뜻을 기다린다 (companion_crossroads).`,
      ),
    );
  }
  return out;
}

/** 임무가 끝나면 짝을 돌려보낸다 (보고·포기 직후) */
export function releaseBuddies(ctx: ToolContext, missionId: string): string[] {
  const state = ctx.store.getState();
  const lines: string[] = [];
  for (const [id, b] of Object.entries(state.bonds ?? {})) {
    if (b.kind !== "buddy" || b.missionId !== missionId) continue;
    ctx.store.append({ type: "companion_left", characterId: id, reason: "임무가 끝났다" });
    lines.push(`짝이던 ${josa(playerCalls(state, ctx.content, id), "은/는")} 자기 자리로 돌아간다.`);
  }
  return lines;
}

/** 임무 짝을 붙인다 (2인 1조). 같은 무리의 아는 동료 중 곁에 있는 사람 먼저 */
export function assignBuddy(ctx: ToolContext, missionId: string, commander: string | null): string | null {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const player = state.characters[state.playerId];
  if (!player?.factionId) return null;
  const known = new Set(state.known[state.playerId] ?? []);
  const pool = Object.values(state.characters)
    .filter((c) => content.npcs[c.id] && c.id !== state.playerId && c.id !== commander && c.factionId === player.factionId)
    .filter((c) => !c.dead && !c.away && !c.captive && !state.squadOrders?.[c.id] && !state.companions.includes(c.id) && !state.bonds?.[c.id])
    .filter((c) => known.has(c.id) && c.rank === player.rank)
    .map((c) => c.id)
    .sort();
  if (!pool.length) return null;
  const here = pool.filter((id) => state.scene.present.includes(id));
  const from = here.length ? here : pool;
  const id = from[Math.floor(rng() * from.length)]!;
  store.append({ type: "companion_joined", characterId: id, kind: "buddy", missionId });
  return id;
}

/** 역할의 시작 동행 (떠돌이의 가족 등). 세계를 만들 때와 새 캐릭터로 이어 갈 때 */
export function addStartCompanions(ctx: ToolContext, role: RoleContent | undefined): void {
  for (const sc of role?.start_companions ?? []) {
    const { store, content, rng } = ctx;
    const template = content.extras[sc.template];
    if (!template) continue;
    const state = store.getState();
    const id = `ex_${state.nextExtraNo}`;
    const usedNames = new Set(Object.values(state.characters).map((c) => c.name));
    const character = createExtraCharacter(content, template, { id, label: sc.label, zone: state.playerZone, time: state.time, usedNames }, rng);
    store.append({ type: "extra_spawned", character });
    // 연고는 서로 이름을 안다
    if (!template.animal) {
      store.append({ type: "name_learned", characterId: state.playerId, targetId: id });
      store.append({ type: "name_learned", characterId: id, targetId: state.playerId });
    }
    store.append({ type: "companion_joined", characterId: id, kind: sc.kind ?? (template.animal ? "animal" : "kin") });
  }
}

const companionPart = defineTool({
  name: "companion_part",
  description:
    "동행과 잠시 떨어지거나 헤어진다 (기획서 7.9). 플레이어가 그렇게 하기로 했을 때만. how: wait 지금 구역에 남아 기다린다(그 구역에 다시 오면 저절로 합류), " +
    "errand 볼일을 보러 갔다가 hours 뒤 돌아온다, end 헤어진다(함께 다니는 이유가 끝난다). 함께 다니게 되는 것은 이야기의 결과로만 생긴다.",
  schema: z.strictObject({
    target: z.string().describe("동행의 id"),
    how: z.enum(["wait", "errand", "end"]),
    hours: z.number().int().min(1).max(72).nullable().describe("errand일 때 몇 시간 뒤 돌아오나. 아니면 null"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const name = playerCalls(state, content, input.target);
    const apart = state.bonds?.[input.target]?.apart;
    if (input.how === "end" && apart) {
      store.append({ type: "companion_left", characterId: input.target, reason: "헤어졌다" });
      return { ok: true, resultText: `${josa(name, "과/와")}의 동행이 끝났다. 다시 만나도 함께 다니지 않는다.`, display: { type: "presence", npcName: name, action: "leave" } };
    }
    if (!activeCompanions(state).includes(input.target)) return { ok: false, error: "곁에 있는 동행이 아니다." };
    if (input.how === "end") {
      store.append({ type: "companion_left", characterId: input.target, reason: "헤어졌다" });
      return { ok: true, resultText: `${josa(name, "은/는")} 더는 함께 다니지 않는다. 헤어지는 장면을 서술한다.`, display: { type: "presence", npcName: name, action: "leave" } };
    }
    if (!state.bonds?.[input.target]) {
      // 이전 세이브의 동행: 이유를 먼저 적어 둔다
      const bond = bondOf(state, content, input.target)!;
      store.append({ type: "companion_bond_changed", characterId: input.target, kind: bond.kind });
    }
    if (input.how === "wait") {
      if (!state.playerZone) return { ok: false, error: "기다릴 구역이 없다." };
      store.append({ type: "companion_parted", characterId: input.target, zone: state.playerZone, until: null });
      return {
        ok: true,
        resultText: `${josa(name, "은/는")} ${content.locations[state.playerZone]?.name ?? state.playerZone}에 남아 기다린다. 이 구역에 다시 오면 합류한다. 남겨 두는 장면을 서술한다.`,
        display: { type: "presence", npcName: `${name} · 기다림`, action: "leave" },
      };
    }
    if (!input.hours) return { ok: false, error: "errand에는 hours(몇 시간 뒤 돌아오나)가 필요하다." };
    const until = state.time + input.hours * 60;
    store.append({ type: "companion_parted", characterId: input.target, zone: null, until });
    return {
      ok: true,
      resultText: `${josa(name, "은/는")} 볼일을 보러 갔다. ${formatTime(until)}쯤 돌아온다. 그 사이 무엇을 하는지는 지어내지 않는다.`,
      display: { type: "presence", npcName: `${name} · 볼일`, action: "leave" },
    };
  },
});

const companionCrossroads = defineTool({
  name: "companion_crossroads",
  description:
    "갈림길(상태의 '갈림길')에서 플레이어의 뜻을 넘긴다. let_go: 보낸다. ask_stay: 붙잡는다 — 그 사람이 남고 싶어 하면 그대로 남고, " +
    "떠나고 싶어 하면 시스템이 판정한다 (move·stat: 설득에 쓰는 스킬과 능력). 결과는 시스템이 정한다.",
  schema: z.strictObject({
    target: z.string(),
    choice: z.enum(["let_go", "ask_stay"]),
    move: z.string().nullable().describe("ask_stay일 때 설득 스킬 id (예: 교섭). let_go면 null"),
    stat: z.string().nullable().describe("그 스킬의 능력 id. let_go면 null"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const bond = state.bonds?.[input.target];
    if (!bond?.crossroads || !state.companions.includes(input.target)) return { ok: false, error: "갈림길에 선 동행이 아니다." };
    const name = playerCalls(state, content, input.target);
    if (input.choice === "let_go") {
      store.append({ type: "companion_left", characterId: input.target, reason: "보냈다" });
      return { ok: true, resultText: `${josa(name, "을/를")} 보냈다. 헤어지는 장면을 서술한다.`, display: { type: "presence", npcName: name, action: "leave" } };
    }
    if (bond.crossroads.lean === "stay") {
      store.append({ type: "companion_bond_changed", characterId: input.target, kind: "kin" });
      return { ok: true, resultText: `${josa(name, "은/는")} 기다렸다는 듯 남는다. 이제 함께 다니는 사이다 (연고).`, display: { type: "presence", npcName: `${name} · 연고`, action: "enter" } };
    }
    if (!input.move || !input.stat) return { ok: false, error: "떠나려는 사람을 붙잡으려면 판정이 필요하다 (move, stat)." };
    const check = rollPlayerCheck({ move: input.move, stat: input.stat, difficulty: "normal", intent: `${name}을(를) 붙잡는다` }, ctx, { target: input.target });
    if (!check.ok) return check;
    const lines = [`판정: ${CHECK_OUTCOME_LABELS[check.outcome]}`];
    if (check.outcome === "success") {
      store.append({ type: "companion_bond_changed", characterId: input.target, kind: "kin" });
      lines.push(`${josa(name, "은/는")} 마음을 바꿔 남기로 했다. 이제 함께 다니는 사이다 (연고).`);
    } else if (check.outcome === "partial") {
      store.append({ type: "companion_bond_changed", characterId: input.target, kind: "purpose", until: { at: state.time + EXTEND_MINUTES } });
      lines.push(`${josa(name, "은/는")} 조금만 더 함께 가겠다고 한다 (${formatTime(state.time + EXTEND_MINUTES)}까지). 그 뒤는 다시 갈림길이다.`);
    } else {
      store.append({ type: "companion_left", characterId: input.target, reason: "붙잡았지만 떠났다" });
      lines.push(`${josa(name, "은/는")} 고개를 젓고 떠난다.`);
    }
    return { ok: true, resultText: lines.join("\n"), display: check.display };
  },
});

export const COMPANION_TOOLS = [companionPart, companionCrossroads] as const;

/** 떨어져 있는 동행은 기다리는 구역에서만 장면·배역에 나온다 */
export function isAwayCompanion(state: Pick<GameState, "bonds" | "playerZone">, id: string): boolean {
  const apart = state.bonds?.[id]?.apart;
  if (!apart) return false;
  return !(apart.zone && apart.zone === state.playerZone);
}
