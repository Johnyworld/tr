import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import { neighbors } from "./war.ts";
import { battleConfig, effectBlocker } from "./battle.ts";
import type { GameWorld } from "../world/world.ts";

/**
 * 랜덤 자동 플레이 (기획서 17: 막힘과 밸런스 점검). LLM 없이 tool만 무작위로 부른다.
 * 오류로 멈추는 곳, 열리지 않는 콘텐츠, 너무 잦거나 드문 사건을 찾는 데 쓴다.
 */
export type AutoplayStats = {
  turns: number;
  days: number;
  errors: string[];
  storyletsFired: Record<string, number>;
  battles: number;
  battlesWon: number;
  deaths: number;
  successions: number;
  missionsAssigned: number;
  zonesVisited: Set<string>;
  levelUps: number;
  /** 상태 트랙별로 판정 보정이 붙는 단계에 있던 턴 수 */
  sufferingTurns: Record<string, number>;
};

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;

export function autoplay(world: GameWorld, content: Content, rng: Rng, turns: number): AutoplayStats {
  const stats: AutoplayStats = {
    turns: 0,
    days: 0,
    errors: [],
    storyletsFired: {},
    battles: 0,
    battlesWon: 0,
    deaths: 0,
    successions: 0,
    missionsAssigned: 0,
    zonesVisited: new Set(),
    levelUps: 0,
    sufferingTurns: {},
  };
  const startTime = world.state().time;
  const base = { check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false };
  const moves = content.scenario.moves;
  const tool = (name: string, input: unknown) => {
    const out = world.executeTool(name, input);
    return out;
  };

  for (let i = 0; i < turns; i++) {
    stats.turns++;
    const s = world.state();
    if (s.playerZone) stats.zonesVisited.add(s.playerZone);
    if (world.isPlayerDead()) {
      stats.deaths++;
      const options = world.successionOptions();
      if (options.length === 0) {
        stats.errors.push("죽었는데 다음 캐릭터 후보가 없다");
        break;
      }
      const r = world.chooseNextCharacter(pick(rng, options).id);
      if (!r.ok) stats.errors.push(`계승 실패: ${r.error}`);
      else stats.successions++;
      continue;
    }
    const me = s.characters[s.playerId]!;
    for (const track of content.scenario.condition_tracks) {
      if ((track.levels.find((l) => l.id === me.conditions[track.id])?.penalty ?? 0) < 0) stats.sufferingTurns[track.id] = (stats.sufferingTurns[track.id] ?? 0) + 1;
    }
    // 레벨업이 쌓였으면 아무 스킬이나 올린다
    if (me.skillPoints > 0) {
      const out = tool("learn_skill", { skill: pick(rng, moves).id });
      if (out.ok) stats.levelUps++;
      else if (!out.error.includes("최고 단계")) stats.errors.push(`learn_skill: ${out.error}`);
      continue;
    }
    const check = (move: (typeof moves)[number], harm: string) => ({
      move: move.id,
      stat: pick(rng, move.stats),
      difficulty: "normal",
      harm_on_failure: harm,
      harm_cause: harm === "none" ? "" : "위험",
      // 위험한 판정의 일부는 감염체에게서 오는 것으로
      infected_source: harm !== "none" && rng() < 0.4,
    });

    // 전투 중: 쓸 수 있는 효과 하나
    if (s.battle) {
      const config = battleConfig(content);
      const player = s.characters[s.playerId]!;
      const usable = config.effects.filter((e) => effectBlocker(e, s.battle!, { items: player.inventory, preparations: s.preparations[s.battle!.zone] ?? [] }) === null);
      const effect = pick(rng, usable);
      const move = moves.find((m) => m.id === (effect.min_harm === "none" ? "stealth" : "fight")) ?? moves[0]!;
      const out = tool("take_action", {
        ...base,
        intent: effect.label,
        battle: { effect: effect.id, objective: effect.targets_objective ? (s.battle.objectives[0] ?? null) : null },
        check: check(move, effect.min_harm === "none" ? "none" : effect.min_harm),
      });
      if (!out.ok) stats.errors.push(`전투: ${out.error}`);
      continue;
    }

    // 진행 중인 이야기: 무작위 선택지 (판정이 붙었으면 먼저 판정)
    if (s.activeStorylet && rng() < 0.7) {
      const storylet = content.storylets[s.activeStorylet.id]!;
      const choice = pick(rng, storylet.choices);
      if (choice.check) {
        const move = moves.find((m) => m.id === choice.check)!;
        tool("take_action", { ...base, intent: choice.label, check: check(move, "none") });
      }
      const out = tool("resolve_storylet", { choice_id: choice.id });
      if (!out.ok && !out.error.includes("없어 이 선택지를") && !out.error.includes("진행 중인 이야기가 없다")) {
        stats.errors.push(`이야기 ${storylet.id}.${choice.id}: ${out.error}`);
      }
      continue;
    }

    // 임무: 상관이 있으면 가끔 받는다
    if (s.offers?.templateIds.length && rng() < 0.1) {
      const commander = content.roles[s.roleId]?.commander;
      if (commander && commander !== s.playerId && !s.characters[commander]?.dead) {
        if (!s.scene.present.includes(commander)) tool("npc_presence", { npc_id: commander, action: "enter" });
        const out = tool("assign_mission", { template_id: pick(rng, s.offers.templateIds) });
        if (out.ok) stats.missionsAssigned++;
      }
    }

    // 다쳤으면 가끔 치료한다 (치료사·구급상자)
    const harmTrack = content.scenario.condition_tracks.find((t) => t.id === content.scenario.harm_track)!;
    // 추위·질병 등: 맞는 소모품이 있으면 가끔 쓴다
    {
      const usable = Object.entries(content.scenario.consumables).find(
        ([i, e]) => (me.inventory[i] ?? 0) > 0 && Object.keys(e).some((t) => t !== harmTrack.id && (content.scenario.condition_tracks.find((x) => x.id === t)?.levels.find((l) => l.id === me.conditions[t])?.penalty ?? 0) < 0),
      );
      if (usable && rng() < 0.3) {
        tool("take_action", { ...base, intent: "소모품", use_item: usable[0] });
        continue;
      }
    }
    if (s.characters[s.playerId]!.conditions[harmTrack.id] !== harmTrack.levels[0]!.id && rng() < 0.3) {
      const player = s.characters[s.playerId]!;
      const item = Object.entries(content.scenario.consumables).find(([i, e]) => e[harmTrack.id] && (player.inventory[i] ?? 0) > 0)?.[0] ?? null;
      const healer = Object.values(content.npcs).find((n) => n.healer && n.zone === s.playerZone && !s.characters[n.id]?.dead);
      if (!item && healer && !s.scene.present.includes(healer.id)) tool("npc_presence", { npc_id: healer.id, action: "enter" });
      const out = tool("take_action", item ? { ...base, intent: "치료", use_item: item } : { ...base, intent: "치료", treatment: { item: null } });
      if (!out.ok) stats.errors.push(`치료: ${out.error}`);
      continue;
    }

    const roll = rng();
    let out;
    if (roll < 0.2 && s.playerZone) {
      out = tool("take_action", { ...base, intent: "이동", move_to: pick(rng, neighbors(content, s.playerZone)) });
    } else if (roll < 0.45) {
      out = tool("take_action", { ...base, intent: "판정", check: check(pick(rng, moves), pick(rng, ["none", "none", "light"])) });
    } else if (roll < 0.75) {
      out = tool("take_action", { ...base, intent: "활동", activity: { kind: pick(rng, ["talk", "rest", "work", "search", "eat"]), until: null } });
    } else {
      out = tool("take_action", { ...base, intent: "기다림", activity: { kind: pick(rng, ["sleep", "wait", "guard_duty"]), until: null } });
    }
    if (!out.ok) stats.errors.push(`행동: ${out.error}`);
  }
  for (const e of world.ctx().store.events()) {
    if (e.type === "storylet_fired") stats.storyletsFired[e.storyletId] = (stats.storyletsFired[e.storyletId] ?? 0) + 1;
    if (e.type === "battle_started") stats.battles++;
    if (e.type === "battle_ended" && e.won) stats.battlesWon++;
  }
  stats.days = Math.round((world.state().time - startTime) / 1440);
  return stats;
}
