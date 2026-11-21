import { heldOf } from "../rules/held.ts";
import type { Content, ScenarioCondition } from "../content/schemas.ts";
import { listedScenario } from "../game/startChoice.ts";
import type { GameEvent, GameState } from "../game/state.ts";
import type { ToolContext } from "./toolkit.ts";
import { josa } from "../text.ts";

/** 목적격 조사 (받침에 따라 을/를) */
export const objectParticle = (word: string): string => josa(word, "을/를").slice(word.length);

/**
 * 시나리오 해금과 클리어 목표 (기획서 12.4.1). tool 하나가 끝날 때마다 그동안 쌓인 이벤트와 지금 상태로 판정한다.
 * - 해금: 목록의 잠긴 시나리오 중 조건 하나라도 채운 것을 연다 (unlock_earned, 모든 판에 남는다)
 * - 클리어: 지금 시나리오의 목표를 이루면 scenario_cleared. 게임은 이어진다 (끝낼지는 플레이어가 정한다)
 * 판정은 코드가 한다. GM에게는 결과만 알린다 (원칙 1, 2)
 */

export type ProgressNotice =
  | { kind: "unlocked"; roleId: string; title: string }
  | { kind: "cleared"; roleId: string; title: string; goal: string; ending: string };

/** 조건 하나를 이번 이벤트들(과 지금 상태)이 채웠는지. roleAt: 이벤트가 일어날 때 플레이하던 시나리오 */
function met(content: Content, state: GameState, events: readonly GameEvent[], roleAt: string, c: ScenarioCondition): boolean {
  if ("reunite" in c) {
    // 찾던 가족 중 누구든 살아서 주인공 앞에 나타났다 (같은 장면). 같은 구역에 들어가기만 해서는 아니다
    return state.family.some((id) => {
      const k = state.characters[id];
      return !!k && !k.dead && !heldOf(k) && state.scene.present.includes(id);
    });
  }
  const attack = new Set(content.scenario.gear?.attack_moves ?? []);
  return events.some((e) => {
    if ("scenario_ended" in c) return (e.type === "scenario_cleared" && e.roleId === c.scenario_ended) || (e.type === "character_died" && roleAt === c.scenario_ended);
    if ("scenario_cleared" in c) return e.type === "scenario_cleared" && e.roleId === c.scenario_cleared;
    if ("enter" in c) return e.type === "zone_moved" && e.to === c.enter;
    if ("join" in c) return e.type === "player_joined_faction" && e.factionId === c.join;
    if ("promoted" in c) return e.type === "promoted" && e.characterId === state.playerId;
    if ("fight" in c) {
      if (e.type === "battle_started") return e.battle.theirs.faction === c.fight;
      if (e.type === "check_rolled" && e.actorId === state.playerId && e.target && attack.has(e.move)) return state.characters[e.target]?.factionId === c.fight;
    }
    return false;
  });
}

/**
 * 이번 tool에서 쌓인 이벤트로 해금·클리어를 판정하고 기록한다. roleAt: tool을 부르기 전에 플레이하던 시나리오.
 * 클리어가 해금 조건(scenario_cleared, scenario_ended)이 될 수 있어 클리어를 먼저 본다
 */
export function checkScenarioProgress(ctx: ToolContext, events: readonly GameEvent[], roleAt: string): ProgressNotice[] {
  const { store, content } = ctx;
  const notices: ProgressNotice[] = [];
  const all = [...events];
  // 1. 지금 시나리오의 클리어 목표
  const role = content.roles[roleAt];
  const goal = role?.scenario?.goal;
  if (role && goal && !store.getState().cleared.includes(role.id)) {
    const state = store.getState();
    // 죽은 뒤에는 클리어하지 않는다
    if (!state.characters[state.playerId]?.dead && goal.when.some((c) => met(content, state, all, roleAt, c))) {
      const e: GameEvent = { type: "scenario_cleared", roleId: role.id };
      store.append(e);
      all.push(e);
      // 다시 만난 가족: 주인공의 앎이 바뀐다 (플레이 테스트 11: 재회 뒤에도 "어디 있는지 모른다").
      // 함께 다니는 것은 데려가겠다고 할 때만 (12-239, 플레이 테스트 13: 79살 노인이 저절로 동행이 되어 전선을 따라다녔다)
      for (const id of state.family) {
        const now = store.getState();
        if (!now.scene.present.includes(id) || now.characters[id]?.dead) continue;
        const where = now.playerZone ? (content.locations[now.playerZone]?.name ?? now.playerZone) : "이곳";
        store.append({ type: "belief_added", characterId: now.playerId, belief: { id: `b_${now.nextBeliefNo}`, fact: `${josa(now.characters[id]!.name, "을/를")} 다시 만났다. ${where}에 산다.`, source: "seen", accuracy: "exact", learnedAt: now.time } });
      }
      notices.push({ kind: "cleared", roleId: role.id, title: role.scenario!.title, goal: goal.text, ending: goal.ending });
    }
  }
  // 2. 잠긴 시나리오의 해금
  for (const r of Object.values(content.roles)) {
    const unlock = r.scenario?.unlock;
    if (!unlock || !listedScenario(r)) continue;
    const state = store.getState();
    // 지금 하는 시나리오는 알리지 않는다 (플레이 테스트 11)
    if (state.unlocked.includes(r.id) || r.id === state.scenarioRole) continue;
    if (!unlock.when.some((c) => met(content, state, all, roleAt, c))) continue;
    store.append({ type: "unlock_earned", id: r.id, inherited: false });
    notices.push({ kind: "unlocked", roleId: r.id, title: r.scenario!.title });
  }
  return notices;
}

/** GM에게 줄 알림 (tool 결과 뒤에 붙는다). 장면 서술과 섞지 않는다 */
export function describeProgressNotices(notices: readonly ProgressNotice[]): string[] {
  const lines: string[] = [];
  for (const n of notices) {
    if (n.kind === "cleared") {
      lines.push(
        // 이야기가 막 열렸으면 선택이 먼저다 (플레이 테스트 12: 재회 이야기의 선택 전에 엔딩을 연출하라고 했다)
        `(시나리오 클리어: ${n.title} — ${n.goal}. 지금 열린 이야기가 있으면 플레이어의 선택을 먼저 받고, 그 결과까지 서술한 뒤 이 장면을 시나리오의 엔딩으로 연출한다: ${n.ending} ` +
          "엔딩을 다 서술한 뒤 게임 밖의 말로 플레이어에게 묻는다: 여기서 끝낼지(end_session으로 저장하고 닫는다), 이 세계에서 계속 살아갈지. 계속하면 주인공이 죽을 때까지 이어진다)",
      );
    }
  }
  const opened = notices.filter((n) => n.kind === "unlocked").map((n) => n.title);
  if (opened.length) {
    const last = opened[opened.length - 1]!;
    lines.push(`(게임 밖 알림: 시나리오 ${opened.map((t) => `「${t}」`).join(", ")}${objectParticle(last)} 플레이할 수 있습니다. 장면 서술과 섞지 말고 이 문장 그대로 짧게 알린다. 새 게임에서 고를 수 있다)`);
  }
  return lines;
}
