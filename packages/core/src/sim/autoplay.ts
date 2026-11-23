import { isIncapacitated } from "../engine/body.ts";
import { heldOf } from "../rules/held.ts";
import { remainsHere } from "../engine/remains.ts";
import { waterHere } from "../engine/body.ts";
import { isCreature } from "../game/kinds.ts";
import { incapacitatingSymptom, raiseCost } from "../scenario/scenario.ts";
import { canUseSkill } from "../engine/traits.ts";
import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import { neighbors } from "./war.ts";
import { choiceAvailable, storyletOf } from "../story/storylets.ts";
import { autoplayImprovInput, describeImprovSlotForGm } from "../engine/improvStory.ts";
import { sitsOnCouncil, squadMembers } from "../engine/command.ts";
import { battleConfig, effectBlocker } from "./battle.ts";
import type { GameWorld } from "../world/world.ts";
import { learned } from "../rules/skill.ts";
import {nearby, fireLitHere } from "../rules/place.ts";

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
    let out = world.executeTool(name, input);
    // 이야기를 둔 채 같은 자리에서 오래 걸리는 일은 거절된다 (플레이 테스트 13): GM처럼 모른 척하고 다시 한다
    if (!out.ok && name === "take_action" && out.error.includes("ignore_story")) out = world.executeTool(name, { ...(input as object), ignore_story: true });
    // 이야기가 열려 있으면 임무를 받거나 보고하기 전에 먼저 받는다 (12-240): GM처럼 모른 척하고 다시 한다
    if (!out.ok && name !== "take_action" && out.error.includes("ignore_story")) {
      world.executeTool("take_action", { ...base, intent: "이야기를 두고 간다", ignore_story: true });
      out = world.executeTool(name, input);
    }
    // 다시 해 볼 수 있는 판정이 남아 되물으면 (12-240) 그대로 보고한다
    if (!out.ok && name === "report_mission" && out.error.includes("final: true")) out = world.executeTool(name, { ...(input as object), final: true });
    // 위협 앞에서는 오래 걸리는 일을 못 한다 (공통 규칙 4): GM처럼 먼저 맞선다
    if (!out.ok && name === "take_action" && out.error.includes("곁에 위협이 있다")) {
      const fight = world.content.scenario.moves.find((m) => m.id === "fight") ?? world.content.scenario.moves[0]!;
      const threats = () => world.state().scene.present.filter((id) => !world.state().characters[id]?.dead && (out.ok ? false : out.error.includes(`(${id})`)));
      let last: ReturnType<typeof world.executeTool> = out;
      const down = () => {
        const me = world.state().characters[world.state().playerId];
        return !me || me.dead || isIncapacitated(world.content, me);
      };
      for (let i = 0; i < 3 && threats().length && !down(); i++) {
        last = world.executeTool(name, { intent: "곁의 위협에 맞선다", target: threats()[0], check: { move: fight.id, stat: fight.stats[0], difficulty: "normal", harm_on_failure: "light", harm_cause: "맞붙었다", harm_kind: "other", infected_source: true, target_harm: "light", distance: "close" }, activity: null, deed: null, narration_summary: null, for_mission: false });
      }
      // 그래도 남았으면 물리친 셈으로 내보낸다 (자동 플레이가 멈추지 않게)
      for (const id of threats()) world.executeTool("npc_presence", { npc_id: id, action: "leave" });
      // 맞서다 쓰러졌거나 죽었으면 하려던 일은 접는다
      if (down()) return last;
      out = world.executeTool(name, input);
      // 맞서는 사이 새 이야기가 열렸으면 모른 척하고 다시 한다
      if (!out.ok && out.error.includes("ignore_story")) out = world.executeTool(name, { ...(input as object), ignore_story: true });
    }
    // 매복에 붙들리면 걸어 나갈 수 없다 (플레이 테스트 13): GM처럼 뿌리치는 판정을 걸고 옮겨 간다
    if (!out.ok && name === "take_action" && out.error.includes("매복에 걸려")) {
      const move = world.content.scenario.moves[0]!;
      const { ignore_story: _ignored, ...rest } = input as Record<string, unknown>;
      out = world.executeTool(name, { ...rest, move_to: (rest.move_to as string | undefined) ?? null, check: { move: move.id, stat: move.stats[0], difficulty: "normal", harm_on_failure: "light", harm_cause: "매복을 뿌리쳤다", harm_kind: "other", infected_source: false, target_harm: "none", distance: "close" } });
      if (!out.ok && !(rest.move_to)) {
        const s = world.state().activeStorylet;
        const pick = s ? storyletOf(world.state(), world.content, s.id)?.choices.find((c) => !c.check) : undefined;
        if (pick) world.executeTool("resolve_storylet", { choice_id: pick.id, improvised_move: null });
        out = world.executeTool(name, rest);
      }
    }
    // 적대하는 땅에서 시간을 들이는 일은 판정을 건다 (플레이 테스트 12): GM처럼 숨기 판정을 붙여 다시 한다
    const alarm = world.content.scenario.alarm;
    if (!out.ok && name === "take_action" && alarm && out.error.includes("적대하는 땅에서 시간을 들이는 일")) {
      const move = world.content.scenario.moves.find((m) => m.id === alarm.moves[0])!;
      return world.executeTool(name, { ...(input as object), check: { move: move.id, stat: move.stats[0], difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" } });
    }
    return out;
  };

  for (let i = 0; i < turns; i++) {
    stats.turns++;
    let s = world.state();
    if (s.playerZone) stats.zonesVisited.add(s.playerZone);
    if (world.isPlayerDead()) {
      stats.deaths++;
      // 이어 갈 수 없으면(튜토리얼, 아무도 만나지 못했다) 죽음으로 끝난다
      if (world.storyEnded()) break;
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
    // 의식불명이면 시간만 흐른다
    if (incapacitatingSymptom(content.scenario, me)) {
      const r = world.executeTool("take_action", { intent: "의식이 없다", check: null, activity: s.battle ? null : { kind: "wait", until: null }, deed: null, target: null, narration_summary: null, for_mission: false });
      if (!r.ok) stats.errors.push(`의식불명 중 기다리기: ${r.error}`);
      continue;
    }
    for (const track of content.scenario.condition_tracks) {
      if ((track.levels.find((l) => l.id === me.conditions[track.id])?.penalty ?? 0) < 0) stats.sufferingTurns[track.id] = (stats.sufferingTurns[track.id] ?? 0) + 1;
    }
    // GM처럼 배운 스킬로만 판정한다 (4.2.1: 못 하는 전문 기술은 거절된다)
    const can = (id: string | undefined) => !id || canUseSkill(content, me, id);
    const usableMoves = moves.filter((m) => can(m.id));
    // 스킬 포인트가 쌓였으면 할 수 있는 스킬 중 아무거나 올린다 (점수가 모자라면 모아 둔다)
    const raisable = usableMoves.filter((m) => {
      const v = learned(content.scenario, me.skills, m.id);
      return v !== null && v < content.scenario.ranges.skill.max && raiseCost(content.scenario, v) <= me.skillPoints;
    });
    if (raisable.length && rng() < 0.8) {
      const out = tool("learn_skill", { skill: pick(rng, raisable).id });
      if (out.ok) stats.levelUps++;
      else stats.errors.push(`learn_skill: ${out.error}`);
      continue;
    }
    const check = (move: (typeof moves)[number], harm: string) => {
      // 위험한 판정의 일부는 감염체에게서 오는 것으로 (물림·할큄)
      // 감염체는 위험의 일부만 (사람·짐승·사고가 더 많다, 12-109에서 0.4 → 0.15)
      const infected = harm !== "none" && rng() < 0.15;
      const kinds = content.scenario.wounds?.kinds ?? [];
      const infectedKinds = kinds.filter((k) => (content.scenario.body?.infection?.chance[k.id] ?? 0) > 0);
      const kind = harm === "none" || !kinds.length ? null : pick(rng, infected && infectedKinds.length ? infectedKinds : kinds).id;
      return {
        move: move.id,
        stat: pick(rng, move.stats),
        difficulty: "normal",
        harm_on_failure: harm,
        harm_cause: harm === "none" ? "" : "위험",
        harm_kind: kind,
        infected_source: infected,
      };
    };

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
    // 즉흥 이야기 자리 (12-247): LLM 대신 대역 이야기로 채우고, 같은 턴에 바로 고른다 (GM도 열고 같은 턴에 플레이어의 대응을 받는다.
    // 따로 턴을 쓰면 400턴 판의 날수가 줄었다). GM에게 보이는 자리만 (누워 있으면 숨겨져 있다)
    if (describeImprovSlotForGm(s, content)) {
      const out = tool("improvise_storylet", autoplayImprovInput(s, content));
      if (!out.ok) stats.errors.push(`즉흥 이야기: ${out.error}`);
      s = world.state();
    }
    const openChoices = s.activeStorylet ? storyletOf(s, content, s.activeStorylet.id)!.choices.filter((c) => choiceAvailable(s, c, s.activeStorylet!.cast) && can(c.check ?? undefined)) : [];
    if (s.activeStorylet && openChoices.length && rng() < 0.7) {
      const storylet = storyletOf(s, content, s.activeStorylet.id)!;
      const choice = pick(rng, openChoices);
      if (choice.check) {
        const move = moves.find((m) => m.id === choice.check)!;
        tool("take_action", { ...base, intent: choice.label, check: check(move, "none") });
        // 판정하는 사이 시간이 흘러 이야기가 지나갔거나 다른 이야기로 바뀌었으면 고르지 않는다
        if (world.state().activeStorylet?.id !== storylet.id) continue;
        // 그 판정으로 죽거나 정신을 잃었으면 고르지 않는다 (다음 턴에 의식불명 처리)
        const after = world.state().characters[world.state().playerId];
        if (!after || after.dead || incapacitatingSymptom(content.scenario, after)) continue;
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

    // 감염이 드러났으면 (플레이어처럼): 혈청이 있으면 쓰고, 없으면 항생제를 하루 하나 (12-106)
    {
      const inf = content.scenario.body?.infection;
      const t = inf && content.scenario.condition_tracks.find((x) => x.id === inf.track);
      const at = t ? t.levels.findIndex((l) => l.id === me.conditions[t.id]) : -1;
      if (inf && t && at > 0 && !t.levels[at]!.hidden) {
        const serum = inf.cure.find((i) => (me.inventory[i] ?? 0) > 0);
        const pill = inf.slow.find((i) => (me.inventory[i] ?? 0) > 0);
        const day = Math.floor(s.time / 1440);
        if (serum) {
          tool("take_action", { ...base, intent: "혈청", use_item: serum });
          continue;
        }
        if (pill && s.recovery.slowDay[me.id] !== day + 1) {
          tool("take_action", { ...base, intent: "항생제", use_item: pill });
          continue;
        }
      }
    }
    // 다쳤으면 가끔 치료한다 (치료사·구급상자)
    const harmTrack = content.scenario.condition_tracks.find((t) => t.id === content.scenario.harm_track)!;
    // 추위·질병 등: 맞는 소모품이 있으면 가끔 쓴다
    {
      // 단계가 오른 트랙 (증상 체계에서는 단계 자체의 penalty가 비어 있어 단계 순서로 본다)
      const stage = (t: string) => Math.max(0, content.scenario.condition_tracks.find((x) => x.id === t)?.levels.findIndex((l) => l.id === me.conditions[t]) ?? 0);
      const usable = Object.entries(content.scenario.consumables).find(
        ([i, e]) => (me.inventory[i] ?? 0) > 0 && Object.entries(e).some(([t, n]) => n > 0 && t !== harmTrack.id && stage(t) > 0),
      );
      const urgent = usable && Object.entries(usable[1]).some(([t, n]) => n > 0 && stage(t) >= 2);
      if (usable && rng() < (urgent ? 0.8 : 0.3)) {
        tool("take_action", { ...base, intent: "소모품", use_item: usable[0] });
        continue;
      }
    }
    // 갇혀 있으면 (12-55): 가끔 탈출을 시도하고, 아니면 버틴다
    if (heldOf(me) && s.playerZone) {
      const c = content.scenario.captivity;
      // 크게 다친 몸으로는 무거운 위험을 건 탈출을 하지 않는다 (사람이라면 낫기를 기다린다. 시드 11에서 연달아 시도하다 피를 흘려 죽었다)
      const hurtNow = harmTrack.levels.findIndex((l) => l.id === me.conditions[harmTrack.id]);
      if (c && hurtNow < 2 && rng() < 0.25) {
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
      const healer = Object.values(content.npcs).find((n) => n.healer && nearby(s, content, n.id));
      if (!item && healer && !s.scene.present.includes(healer.id)) tool("npc_presence", { npc_id: healer.id, action: "enter" });
      let out = item || healer ? tool("take_action", item ? { ...base, intent: "치료", use_item: item } : { ...base, intent: "치료", treatment: { item: null } }) : null;
      // 값을 받는 치료사는 무엇을 낼지 되묻는다: GM처럼 플레이어에게 물은 셈 치고 정해 둔 것으로 낸다
      // (그냥 두면 같은 치료사 앞에서 시간이 흐르지 않는 턴을 수백 번 쓴다)
      if (out && !out.ok && out.error.includes('treatment.pay: "auto"')) out = tool("take_action", { ...base, intent: "치료", treatment: { item: null, pay: "auto" } });
      // 미리 막힌 것(시간이 흐르지 않음: 오늘 이미 치료받음 등)은 플레이어도 겪는 일이라 오류로 세지 않는다
      if (out && !out.ok && !out.error.includes("시간은 흐르지 않았다")) stats.errors.push(`치료: ${out.error}`);
      // 치료할 길이 없으면 쉰다
      if (!item && !healer && hurt >= 2) tool("take_action", { ...base, intent: "쉰다", activity: { kind: "rest", until: null } });
      continue;
    }
    const cold = content.scenario.body?.cold?.track;
    const home = Object.values(content.locations).find((l) => l.owner === me.factionId && l.kind === "base")?.id;
    // 목이 마르고 물이 넉넉한 곳이면 마신다 (12-97)
    const thirst = content.scenario.body?.thirst?.track;
    const water = waterHere(content, s);
    if (thirst && water && water.grant !== "refused" && !(cold && idx(cold) >= 2)) {
      const empty = Object.keys(content.scenario.body!.thirst!.refill).some((i) => (me.inventory[i] ?? 0) > 0);
      if (idx(thirst) > 0 && rng() < 0.7) {
        tool("take_action", { ...base, intent: "물을 마신다", drink: true });
        continue;
      }
      if (empty && rng() < 0.7) {
        tool("take_action", { ...base, intent: "물병을 채운다", refill: true });
        continue;
      }
    }
    // 생존 행동 (12-139): 사람이라면 할 일. 새 기능(먹고 마시기·담배·유해·덫)의 밸런스를 자동 플레이로도 보게
    {
      const shown = (trackId: string | undefined) => {
        if (!trackId) return 0;
        const t = content.scenario.condition_tracks.find((x) => x.id === trackId);
        const i = idx(trackId);
        return t && i > 0 && !t.levels[i]!.hidden ? i : 0;
      };
      const has = (i: string) => (me.inventory[i] ?? 0) > 0;
      const usable = (track: string) =>
        Object.entries(content.scenario.consumables)
          .filter(([i, e]) => (e[track] ?? 0) > 0 && has(i))
          .map(([i]) => i)
          // 상하는 것부터, 끓이지 않은 물은 나중에
          .sort((a, b) => (content.items[b]?.perishable ?? 0) - (content.items[a]?.perishable ?? 0) || (content.items[a]?.contaminated ?? 0) - (content.items[b]?.contaminated ?? 0));
      const infection = content.scenario.body?.infection;
      const cure = infection?.cure.find(has);
      const hunger = content.scenario.body?.hunger?.track;
      const fireItems = Object.keys(content.scenario.body?.cold?.climate?.fire?.items ?? {});
      const fuelHere = fireItems.find(has);
      const fireLit = fireLitHere(s);
      const atBase = !!s.playerZone && content.locations[s.playerZone]?.kind === "base";
      const trapHere = !!s.playerZone && s.traps.some((t) => t.zone === s.playerZone);
      // 덫은 하루가 지나야 걸린다: 놓은 지 하루 넘은 것만 거둔다
      const trapReady = !!s.playerZone && s.traps.some((t) => t.zone === s.playerZone && s.time - t.setAt >= 24 * 60);
      const trapItem = content.scenario.foraging?.trap?.item;
      const wet = !!s.playerZone && !!content.scenario.body?.thirst && (content.locations[s.playerZone]?.yields[content.scenario.body.thirst.resource] ?? 0) > 0;
      const survival = moves.find((m) => m.id === content.scenario.foraging?.move);
      let act: Record<string, unknown> | null = null;
      if (cure && infection && shown(infection.track) > 0) act = { intent: "혈청을 맞는다", use_item: cure };
      else if (hunger && shown(hunger) > 0 && usable(hunger).length && rng() < 0.7) act = { intent: "먹는다", use_item: usable(hunger)[0] };
      else if (thirst && shown(thirst) > 0 && usable(thirst).length && rng() < 0.7) act = { intent: "물병을 마신다", use_item: usable(thirst)[0] };
      else if (shown("craving") > 0 && usable("craving").length) act = { intent: "담배를 피운다", use_item: usable("craving")[0] };
      else if (cold && shown(cold) > 0 && fuelHere && !fireLit && rng() < 0.6) act = { intent: "불을 피운다", use_item: fuelHere };
      else if (remainsHere(s).length && rng() < 0.3) act = { intent: "묻어 준다", bury: { who: remainsHere(s)[0]!.holder, words: null } };
      else if (trapReady && rng() < 0.6) act = { intent: "덫을 거둔다", trap: "check" };
      else if (trapItem && has(trapItem) && can(content.scenario.foraging?.trap?.move) && !atBase && !trapHere && rng() < 0.06) act = { intent: "덫을 놓는다", trap: "set" };
      else if (content.scenario.foraging && !atBase && rng() < 0.06) {
        // 낚시·사냥은 그 일의 스킬로 (전문 기술이면 배웠을 때만)
        const kind = content.scenario.foraging.kinds.find((k) => k.id === (wet ? "fish" : "hunt"));
        const fm = moves.find((m) => m.id === (kind?.move ?? survival?.id));
        if (kind && fm && can(fm.id)) act = { intent: kind.label, forage: kind.id, check: check(fm, "none") };
      }
      if (act) {
        const out = tool("take_action", { ...base, ...act });
        if (!out.ok) stats.errors.push(`생존(${String(act.intent)}): ${out.error}`);
        continue;
      }
    }
    const parched = !!thirst && idx(thirst) >= 2;
    // 배가 고프면 배급을 받으러 거점으로 (12-238: 배급은 우리 땅에서 받는다)
    const hungerTrack = content.scenario.body?.hunger?.track;
    const starving = !!hungerTrack && idx(hungerTrack) >= 2 && !!me.factionId;
    if (((cold && idx(cold) >= 2) || parched || starving) && home && s.playerZone && s.playerZone !== home && rng() < 0.8) {
      const step = nextStep(content, s.playerZone, home);
      if (step) {
        tool("take_action", { ...base, intent: parched ? "목이 말라 거점으로 돌아간다" : starving ? "배가 고파 거점으로 돌아간다" : "추워서 거점으로 돌아간다", move_to: step });
        continue;
      }
    }

    // 지치면 잔다 (12-114). 사람은 졸리면 자러 간다
    const fatigue = content.scenario.body?.fatigue?.track;
    if (fatigue && idx(fatigue) >= 2 && !s.battle && rng() < 0.7) {
      tool("take_action", { ...base, intent: "지쳐서 잔다", activity: { kind: "sleep", until: null } });
      continue;
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
    const doable = (content.scenario.crafting?.recipes ?? []).filter((r) => can(r.move) && Object.entries(r.materials).every(([i, q]) => (me.inventory[i] ?? 0) >= q) && r.tools.every((t) => (typeof t === "string" ? [t] : t).some((x) => (me.inventory[x] ?? 0) > 0)));
    if (doable.length && rng() < 0.1) {
      {
        const r = pick(rng, doable);
        const move = moves.find((m) => m.id === r.move)!;
        const out = tool("take_action", { ...base, intent: r.label, check: check(move, "none"), craft: { recipe: r.id, repair: null } });
        if (!out.ok) stats.errors.push(`제작: ${out.error}`);
        continue;
      }
    }
    // 지금 장면으로 본다: 같은 턴에 이야기를 두고 가면 배역이 나간다 (12-240)
    const merchant = world.state().scene.present.find((id) => content.npcs[id]?.merchant);
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
      // 들이자 곁에 서는 분대원(떨어져 있던 동행이 합류)도 있다: 그러면 따라오라는 명령은 필요 없다
      if (task.kind === "follow" && world.state().companions.includes(member)) continue;
      const zone = task.needs_zone && s.playerZone ? pick(rng, [s.playerZone, ...neighbors(content, s.playerZone)]) : null;
      const out = tool("squad_order", { members: [member], task: task.id, zone });
      if (out.ok) stats.squadOrders++;
      else if (!out.error.includes("장면에 없다") && !out.error.includes("신뢰가 바닥")) stats.errors.push(`분대: ${out.error}`);
      continue;
    }
    if (command?.policies.length && sitsOnCouncil(s, content) && rng() < 0.1) {
      const chair = content.roles[s.roleId]?.commander ?? s.customRole?.commander;
      if (chair && !s.characters[chair]?.dead && !s.scene.present.includes(chair)) tool("npc_presence", { npc_id: chair, action: "enter" });
      const topic = pick(rng, command.policies);
      const approach = pick(rng, command.council_moves.filter((m) => can(m)).length ? command.council_moves.filter((m) => can(m)) : command.council_moves);
      const move = content.scenario.moves.find((m) => m.id === approach)!;
      const out = tool("council_propose", { topic: topic.id, option: pick(rng, topic.options).id, approach, stat: pick(rng, move.stats), intent: "안을 올린다" });
      if (out.ok) stats.councilProposals++;
      else if (!/오늘 이미|기각|이미 그 방침|장면에 없다|사망한/.test(out.error)) stats.errors.push(`회의: ${out.error}`);
      continue;
    }

    // 사람과 엮인다 (기획서 6.3): 엑스트라를 만들거나 구역 인물을 들이고, 가끔 서로 이름을 알게 된다
    if (rng() < 0.08) {
      const templates = Object.keys(content.extras);
      const local = Object.values(content.npcs).filter((n) => nearby(s, content, n.id) && n.id !== s.playerId && !s.scene.present.includes(n.id));
      if (templates.length && (rng() < 0.5 || local.length === 0)) {
        const spawned = tool("spawn_extra", { template: pick(rng, templates), label: "지나가던 사람" });
        if (!spawned.ok) stats.errors.push(`엑스트라: ${spawned.error}`);
      } else if (local.length) {
        tool("npc_presence", { npc_id: pick(rng, local).id, action: "enter" });
      }
      // 이름은 사람끼리만 나눈다 (동물·감염체는 빼고, 12-111)
      const here = world.state().scene.present.filter((id) => !world.state().characters[id]?.dead && !isCreature(content, world.state().characters[id]));
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
      // 탈 것이 있으면 절반쯤은 타고 간다 (12-137)
      const me = s.characters[s.playerId]!;
      const vehicle = Object.keys(me.inventory).find((i) => (me.inventory[i] ?? 0) > 0 && content.items[i]?.vehicle);
      // 사람은 거점으로 돌아온다: 밖에 있으면 열에 넷은 거점 쪽으로 (무작위로만 걸으면 거점 이야기를 못 보고 떠돈다)
      const homeward = home && s.playerZone !== home && rng() < 0.4 ? nextStep(content, s.playerZone, home) : null;
      out = tool("take_action", { ...base, intent: "이동", move_to: homeward ?? pick(rng, neighbors(content, s.playerZone)), ride: vehicle && rng() < 0.5 ? vehicle : null });
    } else if (roll < 0.45) {
      // 다친 몸으로는 위험한 일을 하지 않는다
      out = tool("take_action", { ...base, intent: "판정", check: check(pick(rng, usableMoves), hurt > 0 ? "none" : pick(rng, ["none", "none", "light"])) });
    } else if (roll < 0.75) {
      // 뒤질 때는 GM처럼 수색 판정을 건다 (12-220: 판정 없이는 찾지 못한다)
      const kind = pick(rng, ["talk", "rest", "work", "search", "eat"]);
      const scavengeMove = content.scenario.moves.find((m) => m.id === (content.scenario.exploration?.search_move ?? "scavenge"));
      out = tool("take_action", { ...base, intent: "활동", activity: { kind, until: null }, ...(kind === "search" && scavengeMove ? { check: check(scavengeMove, "none") } : {}) });
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
    if (e.type === "storylet_fired") {
      // 즉흥 이야기는 하나로 센다 (id가 매번 다르다)
      const key = e.improvised ? "(즉흥)" : e.storyletId;
      stats.storyletsFired[key] = (stats.storyletsFired[key] ?? 0) + 1;
    }
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
