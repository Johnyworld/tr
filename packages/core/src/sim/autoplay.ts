import { npcZoneAt } from "../game/whereabouts.ts";
import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import { neighbors } from "./war.ts";
import { choiceAvailable } from "../story/storylets.ts";
import { sitsOnCouncil, squadMembers } from "../engine/command.ts";
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
  /** 분대 명령·회의 안 (기획서 9.11) */
  squadOrders: number;
  councilProposals: number;
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
    squadOrders: 0,
    councilProposals: 0,
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
      // 탄약이 떨어졌으면 무기를 내려놓고 맨손으로 (기획서 4.8). 오류로 치지 않는다
      if (!out.ok && /쏠 수 없다|노릴 수 없다|공격할 수 없다/.test(out.error)) {
        tool("equip", { item_id: null, slot: "weapon" });
        continue;
      }
      if (!out.ok) stats.errors.push(`전투: ${out.error}`);
      continue;
    }

    // 진행 중인 이야기: 무작위 선택지 (판정이 붙었으면 먼저 판정)
    // GM처럼 지금 고를 수 있는 선택지 중에서
    const openChoices = s.activeStorylet ? content.storylets[s.activeStorylet.id]!.choices.filter((c) => choiceAvailable(s, c, s.activeStorylet!.cast)) : [];
    if (s.activeStorylet && openChoices.length && rng() < 0.7) {
      const storylet = content.storylets[s.activeStorylet.id]!;
      const choice = pick(rng, openChoices);
      if (choice.check) {
        const move = moves.find((m) => m.id === choice.check)!;
        tool("take_action", { ...base, intent: choice.label, check: check(move, "none") });
        // 판정하는 사이 시간이 흘러 이야기가 지나갔거나 다른 이야기로 바뀌었으면 고르지 않는다
        if (world.state().activeStorylet?.id !== storylet.id) continue;
      }
      const out = tool("resolve_storylet", { choice_id: choice.id });
      if (!out.ok && !out.error.includes("진행 중인 이야기가 없다")) {
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
    // 갇혀 있으면 (12-55): 가끔 탈출을 시도하고, 아니면 버틴다
    if (me.captive && s.playerZone) {
      const c = content.scenario.captivity;
      if (c && rng() < 0.25) {
        const move = moves.find((m) => m.id === c.escape_moves[0])!;
        const out = tool("take_action", { ...base, intent: "탈출", move_to: pick(rng, neighbors(content, s.playerZone)), check: check(move, "heavy") });
        if (!out.ok) stats.errors.push(`탈출: ${out.error}`);
      } else tool("take_action", { ...base, intent: "버틴다", activity: { kind: "wait", until: null } });
      continue;
    }
    // 몸을 돌본다 (플레이어처럼): 다쳤으면 자주 치료하고, 크게 다쳤으면 쉬고, 얼면 거점으로 돌아간다
    const idx = (trackId: string) => {
      const t = content.scenario.condition_tracks.find((x) => x.id === trackId);
      return t ? t.levels.findIndex((l) => l.id === me.conditions[trackId]) : 0;
    };
    const hurt = idx(harmTrack.id);
    if (hurt > 0 && rng() < (hurt >= 2 ? 0.8 : 0.4)) {
      const player = s.characters[s.playerId]!;
      const item = Object.entries(content.scenario.consumables).find(([i, e]) => e[harmTrack.id] && (player.inventory[i] ?? 0) > 0)?.[0] ?? null;
      const healer = Object.values(content.npcs).find((n) => n.healer && npcZoneAt(n, s.time) === s.playerZone && !s.characters[n.id]?.dead);
      if (!item && healer && !s.scene.present.includes(healer.id)) tool("npc_presence", { npc_id: healer.id, action: "enter" });
      const out = tool("take_action", item ? { ...base, intent: "치료", use_item: item } : { ...base, intent: "치료", treatment: { item: null } });
      if (!out.ok) stats.errors.push(`치료: ${out.error}`);
      // 치료할 길이 없으면 쉰다
      if (!item && !healer && hurt >= 2) tool("take_action", { ...base, intent: "쉰다", activity: { kind: "rest", until: null } });
      continue;
    }
    const cold = content.scenario.body?.cold?.track;
    const home = Object.values(content.locations).find((l) => l.owner === me.factionId && l.kind === "base")?.id;
    if (cold && idx(cold) >= 2 && home && s.playerZone && s.playerZone !== home && rng() < 0.8) {
      const step = nextStep(content, s.playerZone, home);
      if (step) {
        tool("take_action", { ...base, intent: "추워서 거점으로 돌아간다", move_to: step });
        continue;
      }
    }

    // 동행 (기획서 7.9): 갈림길이면 정하고, 가끔 잠시 떼어 놓는다
    const crossing = s.companions.find((id) => s.bonds[id]?.crossroads);
    if (crossing && rng() < 0.5) {
      const ask = rng() < 0.5;
      const out = tool("companion_crossroads", { target: crossing, choice: ask ? "ask_stay" : "let_go", move: ask ? "persuade" : null, stat: ask ? "charm" : null });
      if (!out.ok) stats.errors.push(`갈림길: ${out.error}`);
      continue;
    }
    if (s.companions.length && rng() < 0.03) {
      const target = pick(rng, s.companions);
      const how = pick(rng, ["wait", "errand", "errand", "end"] as const);
      const out = tool("companion_part", { target, how, hours: how === "errand" ? 3 + Math.floor(rng() * 10) : null });
      if (!out.ok && !out.error.includes("곁에 있는 동행이 아니다")) stats.errors.push(`동행: ${out.error}`);
      continue;
    }

    // 물건 (기획서 4.8): 가끔 다른 장비를 들고 입고, 재료가 있으면 만들고, 상인과 흥정한다
    const wearable = content.scenario.gear ? Object.keys(me.inventory).filter((id) => content.items[id]?.weapon || content.items[id]?.armor) : [];
    if (wearable.length > 1 && rng() < 0.04) {
      const out = tool("equip", { item_id: pick(rng, wearable), slot: null });
      if (!out.ok) stats.errors.push(`장비: ${out.error}`);
      continue;
    }
    const doable = (content.scenario.crafting?.recipes ?? []).filter((r) => Object.entries(r.materials).every(([i, q]) => (me.inventory[i] ?? 0) >= q) && r.tools.every((t) => (me.inventory[t] ?? 0) > 0));
    if (doable.length && rng() < 0.1) {
      {
        const r = pick(rng, doable);
        const move = moves.find((m) => m.id === r.move)!;
        const out = tool("take_action", { ...base, intent: r.label, check: check(move, "none"), craft: { recipe: r.id, repair: null } });
        if (!out.ok) stats.errors.push(`제작: ${out.error}`);
        continue;
      }
    }
    const merchant = s.scene.present.find((id) => content.npcs[id]?.merchant);
    if (merchant && rng() < 0.3) {
      const goods = Object.entries(s.characters[merchant]!.inventory).filter(([, q]) => q > 0);
      const mine = Object.entries(me.inventory).filter(([i, q]) => q > 0 && !content.items[i]?.weapon);
      if (goods.length && mine.length) {
        const [want] = pick(rng, goods);
        const [offer, have] = pick(rng, mine);
        const out = tool("barter", { npc_id: merchant, give: { [offer]: Math.min(have, 1 + Math.floor(rng() * 3)) }, get: { [want]: 1 }, move: "persuade", stat: "charm" });
        if (!out.ok && !/모자란다|흥정하려면/.test(out.error)) stats.errors.push(`흥정: ${out.error}`);
      }
      continue;
    }

    // 지휘 (기획서 9.11): 분대가 있으면 가끔 일을 맡기고, 회의에 앉으면 가끔 안을 올린다
    const command = content.scenario.command;
    const squad = squadMembers(s, content).filter((id) => !s.squadOrders[id] && !s.companions.includes(id));
    if (command?.squad_tasks.length && squad.length && rng() < 0.1) {
      const task = pick(rng, command.squad_tasks);
      const member = pick(rng, squad);
      if (!s.scene.present.includes(member)) tool("npc_presence", { npc_id: member, action: "enter" });
      const zone = task.needs_zone && s.playerZone ? pick(rng, [s.playerZone, ...neighbors(content, s.playerZone)]) : null;
      const out = tool("squad_order", { members: [member], task: task.id, zone });
      if (out.ok) stats.squadOrders++;
      else if (!out.error.includes("장면에 없다")) stats.errors.push(`분대: ${out.error}`);
      continue;
    }
    if (command?.policies.length && sitsOnCouncil(s, content) && rng() < 0.1) {
      const chair = content.roles[s.roleId]?.commander ?? s.customRole?.commander;
      if (chair && !s.characters[chair]?.dead && !s.scene.present.includes(chair)) tool("npc_presence", { npc_id: chair, action: "enter" });
      const topic = pick(rng, command.policies);
      const approach = pick(rng, command.council_moves);
      const move = content.scenario.moves.find((m) => m.id === approach)!;
      const out = tool("council_propose", { topic: topic.id, option: pick(rng, topic.options).id, approach, stat: pick(rng, move.stats), intent: "안을 올린다" });
      if (out.ok) stats.councilProposals++;
      else if (!/오늘 이미|기각|이미 그 방침|장면에 없다|사망한/.test(out.error)) stats.errors.push(`회의: ${out.error}`);
      continue;
    }

    // 사람과 엮인다 (기획서 6.3): 엑스트라를 만들거나 구역 인물을 들이고, 가끔 서로 이름을 알게 된다
    if (rng() < 0.08) {
      const templates = Object.keys(content.extras);
      const local = Object.values(content.npcs).filter((n) => npcZoneAt(n, s.time) === s.playerZone && n.id !== s.playerId && !s.characters[n.id]?.dead && !s.scene.present.includes(n.id));
      if (templates.length && (rng() < 0.5 || local.length === 0)) {
        const spawned = tool("spawn_extra", { template: pick(rng, templates), label: "지나가던 사람" });
        if (!spawned.ok) stats.errors.push(`엑스트라: ${spawned.error}`);
      } else if (local.length) {
        tool("npc_presence", { npc_id: pick(rng, local).id, action: "enter" });
      }
      const here = world.state().scene.present.filter((id) => !world.state().characters[id]?.dead);
      if (here.length && rng() < 0.5) {
        const target = pick(rng, here);
        const who = pick(rng, ["player", "target"] as const);
        const out = tool("learn_name", { target, who });
        if (!out.ok && !out.error.includes("이미")) stats.errors.push(`이름: ${out.error}`);
      }
      continue;
    }

    const roll = rng();
    let out;
    if (roll < 0.2 && s.playerZone) {
      out = tool("take_action", { ...base, intent: "이동", move_to: pick(rng, neighbors(content, s.playerZone)) });
    } else if (roll < 0.45) {
      // 다친 몸으로는 위험한 일을 하지 않는다
      out = tool("take_action", { ...base, intent: "판정", check: check(pick(rng, moves), hurt > 0 ? "none" : pick(rng, ["none", "none", "light"])) });
    } else if (roll < 0.75) {
      out = tool("take_action", { ...base, intent: "활동", activity: { kind: pick(rng, ["talk", "rest", "work", "search", "eat"]), until: null } });
    } else {
      out = tool("take_action", { ...base, intent: "기다림", activity: { kind: pick(rng, ["sleep", "wait", "guard_duty"]), until: null } });
    }
    if (!out.ok && out.error.includes("짐이 너무 무겁다")) {
      // 플레이어처럼: 들고 있지 않은 것 중 가장 무거운 것을 내려놓는다
      const p = world.state().characters[world.state().playerId]!;
      const worn = new Set(Object.values(p.equipped ?? {}).filter(Boolean));
      const heavy = Object.entries(p.inventory)
        .filter(([id, n]) => n > 0 && !worn.has(id))
        .sort((a, b) => (content.items[b[0]]?.weight ?? 0) * b[1] - (content.items[a[0]]?.weight ?? 0) * a[1])[0];
      if (heavy) tool("transfer_item", { from: p.id, to: "scene", item_id: heavy[0], quantity: heavy[1] });
    } else if (!out.ok) stats.errors.push(`행동: ${out.error}`);
  }
  for (const e of world.ctx().store.events()) {
    if (e.type === "storylet_fired") stats.storyletsFired[e.storyletId] = (stats.storyletsFired[e.storyletId] ?? 0) + 1;
    if (e.type === "battle_started") stats.battles++;
    if (e.type === "battle_ended" && e.won) stats.battlesWon++;
  }
  stats.days = Math.round((world.state().time - startTime) / 1440);
  return stats;
}

/** from에서 to로 가는 다음 구역 (넓이 우선) */
function nextStep(content: Content, from: string, to: string): string | null {
  const prev = new Map<string, string>([[from, from]]);
  const queue = [from];
  while (queue.length) {
    const z = queue.shift()!;
    if (z === to) break;
    for (const n of neighbors(content, z)) {
      if (prev.has(n)) continue;
      prev.set(n, z);
      queue.push(n);
    }
  }
  if (!prev.has(to)) return null;
  let step = to;
  while (prev.get(step) !== from) step = prev.get(step)!;
  return step;
}
