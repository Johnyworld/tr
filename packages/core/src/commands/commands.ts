import { heldOf, heldSeenZone } from "../rules/held.ts";
import { maskUnknownNames } from "../engine/storyletTools.ts";
import { visitedZones } from "../views/map.ts";
import { knownOwner } from "../rules/knowledge.ts";
import { neighbors } from "../sim/war.ts";
import { resolveLine } from "../engine/resolve.ts";
import { promiseLines } from "../engine/promises.ts";
import { rankName } from "../game/ranks.ts";
import { disciplineOf } from "../game/culture.ts";
import { memoAccess } from "../game/memo.ts";
import { josa } from "../text.ts";
import { headingAs, knowsDeath, playerCalls, withKnownNames } from "../game/acquaintance.ts";
import { traitLabels } from "../engine/traits.ts";
import { growthLine } from "../engine/growth.ts";
import { skillLines } from "../rules/skill.ts";
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import type { TurnSummary } from "../engine/log.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { activeMissionOf, commanderOf, daysServed, MISSION_CHECK_TRIES, MISSION_STATUS_LABELS, missionStatusLabel } from "../game/missions.ts";
import { NEUTRAL_RELATION, RELATION_MAX, RELATION_MIN, relationLabel } from "../game/reputation.ts";
import { dayOf, formatAgo, formatTime, minuteOfDay, SEGMENT_LABELS, segmentOf } from "../rules/time.ts";
import { conditionPenalty, shownLevel, visibleSymptoms } from "../scenario/scenario.ts";
import { describeRequirement } from "../engine/missionTools.ts";
import { editDistance, gauge, gaugeLine, header, signed } from "./format.ts";
import { factionOutlook, WAR_INTEL_TOPIC, WAR_TOPIC, zoneOutlook } from "../engine/warTools.ts";
import { formatChronicle, storyEnded, successionOptions } from "../engine/succession.ts";
import { seasonAt, seasonLabel } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";
import { buildPlayerView, type PlayerView } from "../views/player.ts";
import { personProfile } from "../views/person.ts";
import { DIALOGUE_STYLE_LABELS } from "../engine/storyletTools.ts";
import { beliefText } from "../rules/lens.ts";

/**
 * MUD식 정보 명령어 (기획서 11.7).
 * - 읽기 전용: 게임 시간을 쓰지 않고 상태를 바꾸지 않는다 (원칙 11, 테스트로 보장)
 * - 모든 출력은 정보 필터를 거친다: 플레이어가 아는 것, 플레이어가 느끼는 관계만
 * - 행동(이동, 수색, 전투)은 명령어로 만들지 않는다. 자연어 → take_action
 */

/** 명령어가 읽는 것. 모두 읽기 전용이다 */
export type CommandContext = {
  readonly state: GameState;
  readonly content: Content;
  /** 현재 캐릭터의 요약 기록 (오래된 것부터) */
  readonly summaries: readonly TurnSummary[];
  /** !일지 검색어로 memory를 의미 검색한 결과 (정보 필터를 거친 것). 없으면 단순 문자열 검색 */
  readonly memoryHits?: readonly { text: string }[] | null;
  /** 결과에 보여 줄 명령어 접두사 (웹 "!", MCP "?"). 없으면 "!" */
  readonly prefix?: string;
};

export type CommandDef = {
  id: string;
  /** 대표 이름 (! 뒤에 쓰는 말) */
  name: string;
  aliases: readonly string[];
  args?: string;
  description: string;
  run: (ctx: CommandContext, args: string) => string;
};

const NOT_YET = (what: string, step: string) => `${what}: 아직 없습니다 (${step}에서 추가됩니다).`;

function playerOf(ctx: CommandContext) {
  const player = ctx.state.characters[ctx.state.playerId];
  if (!player) throw new Error("플레이어 캐릭터가 없습니다.");
  return player;
}

function roleLabelOf(ctx: CommandContext) {
  const player = playerOf(ctx);
  const role = ctx.content.roles[ctx.state.roleId];
  return role?.rank === player.rank ? role.label : rankName(ctx.content, player.factionId, player.rank);
}

function clockLine(state: GameState) {
  const m = minuteOfDay(state.time);
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  // 날짜로 센다 (PT22·PT23 섬: 4일차 새벽에 "복무 3일째"였다)
  const days = dayOf(state.time) - dayOf(state.runStartedAt) + 1;
  const free = !state.characters[state.playerId]?.factionId;
  return `${dayOf(state.time)}일차 · ${hhmm} · ${SEGMENT_LABELS[segmentOf(state.time)]} · ${free ? "" : "복무 "}${days}일째`;
}

/** 관계 축 하나를 게이지로 (-10 ~ +10을 0 ~ 20으로) */
function relationGauge(value: number) {
  return gauge(value - RELATION_MIN, RELATION_MAX - RELATION_MIN);
}

const status: CommandDef = {
  id: "status",
  name: "상태",
  aliases: ["스탯", "status"],
  description: "능력, 스킬, 경험치, 몸 상태, 소속·평판·진급, 동행, 분대, 전투",
  run(ctx) {
    const { state, content } = ctx;
    const scenario = content.scenario;
    const player = playerOf(ctx);
    const view = buildPlayerView(state, content);
    const lines = [header(`${player.name} · ${roleLabelOf(ctx)}`), clockLine(state)];
    const who = [view.genderLabel, view.age ? `${view.age}세` : null, view.occupationLabel ? `직분 ${view.occupationLabel}` : null].filter(Boolean);
    if (who.length) lines.push(who.join(" · "));
    lines.push("");
    lines.push(scenario.stats.map((s) => `${s.label} ${signed(player.stats[s.id] ?? 0)}`).join("   "), "");
    const traits = traitLabels(content, player);
    // 없어도 줄을 보인다 (12-239, 플레이 테스트 13: 트레잇 없이 만든 주인공에게 줄이 없어 성격이 빠진 줄 알았다)
    lines.push(`트레잇  ${traits.length ? traits.join(" · ") : "없음"}`);
    lines.push(...skillLines(content, player));
    const growth = growthLine(scenario, player);
    if (growth) lines.push(growth);
    lines.push("");
    // 있는 증상만 보인다 (처음 단계는 빼고, 숨은 단계(잠복기)는 캐릭터가 모르므로 처음 단계로 보인다). 하나도 없으면 "건강함"
    // 증상이 정해진 월드는 원인(트랙) 없이 증상만 (겹치는 증상은 하나, 12-74)
    const shownSymptoms = scenario.symptoms?.length ? visibleSymptoms(scenario, player) : null;
    const symptoms = shownSymptoms ? (shownSymptoms.length ? [`몸 상태  ${shownSymptoms.map((x) => x.label).join(" · ")}`] : []) : scenario.condition_tracks.flatMap((track) => {
      const shown = shownLevel(track, player.conditions[track.id]);
      const index = track.levels.indexOf(shown);
      return index > 0 ? [gaugeLine(track.label, index, track.levels.length - 1, shown.label)] : [];
    });
    lines.push(...(symptoms.length ? symptoms : ["몸 상태  건강함"]));
    for (const x of shownSymptoms ?? []) if (x.hint) lines.push(`  ${x.label}: ${x.hint}`);
    const penalty = conditionPenalty(scenario, player);
    if (penalty !== 0) lines.push(`판정 보정 ${signed(penalty)}`);
    lines.push("");
    const commanderId = commanderOf(state, content);
    const commander = commanderId ? state.characters[commanderId] : undefined;
    lines.push(`소속  ${player.factionId ? roleLabelOf(ctx) : `무소속 · ${roleLabelOf(ctx)}`}${commander ? ` (상관 ${commander.name})` : ""}`);
    // 갇혀 있으면 그렇다고 (플레이 테스트 13: ?상태에 갇힌 것이 나오지 않았다)
    if (heldOf(player)) lines.push(`갇힘  ${ctx.content.factions[heldOf(player)!.by]?.name ?? heldOf(player)!.by} · ${ctx.content.locations[heldOf(player)!.zone]?.name ?? heldOf(player)!.zone}`);
    const trust = commander ? (state.perceived[commander.id]?.trust ?? 0) : null;
    if (player.factionId) {
      lines.push(
        `평판  공적 ${player.merit} · 임무 불복종 ${player.disobedience}회` +
          (trust !== null && commander ? ` · ${commander.name}의 신뢰 ${relationLabel(trust)}` : ""),
      );
      if (view.service.promotionMissing?.length) lines.push(`진급까지  ${view.service.promotionMissing.join(", ")}`);
    }
    // 다짐 (플레이 테스트 13: ?상태에 다짐이 없었다)
    {
      const vow = resolveLine(state, content);
      if (vow) lines.push(`다짐  ${vow}`);
    }
    if (view.companions.length) {
      lines.push(`동행  ${view.companions.map((c) => `${c.name} (${c.bondLabel}${c.note ? ` · ${c.note}` : ""}${c.apart && !c.note ? " · 떨어져 있음" : ""})`).join(", ")}`);
    }
    if (view.squad) {
      lines.push("", "분대");
      lines.push(...(view.squad.length ? view.squad.flatMap((m) => [`  ${m.name}${m.doing ? ` · ${m.doing}` : ""}`, ...(m.report ? [`    보고: ${m.report}`] : [])]) : ["  없음"]));
    }
    if (view.battle) {
      const b = view.battle;
      const bar = `${"◀".repeat(Math.max(0, -b.momentum))}${"·".repeat(b.momentumMax - Math.abs(b.momentum))}${"▶".repeat(Math.max(0, b.momentum))}`;
      lines.push("", `전투  ${b.title} (${b.sideLabel} · ${b.round}라운드)`, `  전세 ${bar} ${b.momentumLabel}`, `  경보 ${b.alarmLabel} · 위치 ${b.positionLabel}`);
    }
    const debts = Object.entries(player.debts ?? {});
    if (debts.length) lines.push(`빚    ${debts.map(([f, n]) => `${ctx.content.factions[f]?.name ?? f} ${n}`).join(" · ")}`);
    if (player.dead) lines.push("", "사망했습니다.");
    return lines.join("\n");
  },
};

const inventory: CommandDef = {
  id: "inventory",
  name: "소지품",
  aliases: ["인벤", "가방", "inventory"],
  description: "가진 물건과 주변에 놓인 물건",
  run(ctx) {
    const player = playerOf(ctx);
    const list = (inv: Record<string, number>) =>
      Object.entries(inv).map(([id, qty]) => `  ${ctx.content.items[id]?.name ?? id}${qty > 1 ? ` ×${qty}` : ""}`);
    const own = list(player.inventory);
    const scene = list(ctx.state.scene.items);
    return [
      header("소지품"),
      ...(own.length ? own : ["  없음"]),
      ...(scene.length ? ["", "주변에 놓인 물건", ...scene] : []),
      ...(() => {
        // 창고 (12-149): 여기 맡겨 둔 것과 넣을 수 있는 자리
        const stash = buildPlayerView(ctx.state, ctx.content).stash;
        if (!stash) return [];
        const kept = stash.items.map((i) => `  ${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`);
        return [
          "",
          stash.label ? `창고 (${stash.label})` : "여기 맡겨 둔 물건",
          ...(kept.length ? kept : stash.label ? ["  비어 있음"] : []),
          ...(stash.home ? [`  거처: ${stash.home}`] : []),
        ];
      })(),
      ...(() => {
        const gear = buildPlayerView(ctx.state, ctx.content).gear;
        return gear ? ["", burdenLine(gear), `장비는 ${ctx.prefix ?? "!"}장비`] : [];
      })(),
    ].join("\n");
  },
};

const map: CommandDef = {
  id: "map",
  name: "지도",
  aliases: ["map"],
  description: "현재 구역, 맞닿은 구역과 그 주인",
  run(ctx) {
    const z = zoneOutlook(ctx.state, ctx.content);
    if (!z) return [header("지도"), NOT_YET("장소와 이동", "장소 시스템")].join("\n");
    return [
      header("지도"),
      `현재  ${z.name} · ${z.owner}`,
      `  ${z.description}`,
      ...(z.preparations.length ? [`  설치해 둔 것: ${z.preparations.join(", ")}`] : []),
      "",
      "맞닿은 구역 (이동 30분~1시간)",
      // 맞닿은 곳이 없으면 비워 두지 않는다 (PT15 섬: 제목만 있고 비어 있었다)
      ...(z.adjacent.length ? z.adjacent.map((a) => `  ${a.name} · ${a.owner}`) : [`  없음${z.crossings.length ? "" : " (걸어서 나갈 길이 없다)"}`]),
      ...(z.crossings.length ? ["", "건너는 길 (배, 들어서 안다)", ...z.crossings.map((c) => `  ${c.name} · ${c.owner}`)] : []),
      "",
      // 가 본 곳 (12-201). 채팅에서는 글자 그림 대신 목록 (12-239, 플레이 테스트 13: 글자 그림이 읽히지 않았다). 그림 지도는 상태 화면의 지도 탭
      "가 본 곳 (주인은 본 대로 · 맞닿은 곳)",
      ...visitedZones(ctx.state).map((id) => {
        const owner = knownOwner(ctx.state, ctx.content, id);
        const ownerName = owner ? (ctx.content.factions[owner]?.name ?? owner) : "주인 없음";
        const adj = neighbors(ctx.content, id).map((n) => ctx.content.locations[n]?.name ?? n).join(", ");
        return `  ${[ctx.content.locations[id]?.name ?? id, ownerName, adj].filter(Boolean).join(" · ")}`;
      }),
    ].join("\n");
  },
};

const time: CommandDef = {
  id: "time",
  name: "시간",
  aliases: ["시각", "time"],
  description: "날짜, 시각, 계절, 날씨",
  run: (ctx) => {
    const season = seasonAt(ctx.content.scenario, ctx.state.time);
    return [
      header("시간"),
      clockLine(ctx.state),
      formatTime(ctx.state.time),
      "",
      season ? `계절  ${seasonLabel(season)} (${season.label} ${season.dayInSeason}/${season.days}일)` : NOT_YET("계절", "계절 단계"),
      (() => {
        const w = weatherNow(ctx.content.scenario, ctx.state);
        return w ? `날씨  ${w.label} — ${w.description}` : NOT_YET("날씨", "날씨 단계");
      })(),
    ].join("\n");
  },
};

const people: CommandDef = {
  id: "people",
  name: "인물",
  aliases: ["사람", "people"],
  args: "[이름]",
  description: "아는 인물 목록 / 특정 인물에 대해 아는 것과 관계",
  run(ctx, args) {
    const { state, content } = ctx;
    // 만난 사람 모두 (이름을 모르면 호칭으로, 기획서 6.3)
    const known = [...new Set([...(state.known[state.playerId] ?? []), ...(state.met[state.playerId] ?? [])])].filter(
      (id) => state.characters[id] && id !== state.playerId,
    );
    const call = (id: string) => playerCalls(state, content, id);
    if (!args) {
      if (known.length === 0) return [header("인물"), "아는 인물이 없습니다."].join("\n");
      const present = new Map(buildPlayerView(state, content).present.map((p) => [p.id, p]));
      return [
        header("인물"),
        ...known.map((id) => {
          const c = state.characters[id]!;
          const r = state.perceived[id] ?? NEUTRAL_RELATION;
          const shown = present.get(id);
          const here = state.scene.present.includes(id) ? ` · 함께 있음${shown?.conditionLabel ? ` (${shown.conditionLabel})` : ""}` : "";
          const attitude = state.perceived[id] ? `신뢰 ${relationLabel(r.trust)} · 호감 ${relationLabel(r.affection)} · 존중 ${relationLabel(r.respect)}` : "아직 만나 보지 않음";
          return `${headingAs(state, content, state.playerId, id)}  ${rankName(content, c.factionId, c.rank)}${c.dead && knowsDeath(state, content, id) ? " · 사망" : c.away ? " · 떠남" : heldOf(c) ? (state.playerZone === heldOf(c)!.zone && heldSeenZone(state, id) === state.playerZone ? " · 여기 붙잡혀 있음" : heldSeenZone(state, id) ? ` · ${content.locations[heldSeenZone(state, id)!]?.name}에 붙잡혀 있는 것을 봤음` : " · 행방 모름") : ""}${here}  (${attitude})`;
        }),
        "",
        `자세히: ${ctx.prefix ?? "!"}인물 이름`,
      ].join("\n");
    }
    const query = args.trim();
    // 이름을 아는 인물은 이름으로, 모르는 인물은 호칭으로 찾는다 (모르는 이름으로는 찾을 수 없다)
    const id = known.find((k) => call(k) === query || k === query) ?? known.find((k) => call(k).includes(query));
    if (!id) return `아는 인물 중에 ${josa(`"${query}"`, "이/가")} 없습니다. 목록: ${ctx.prefix ?? "!"}인물`;
    const p = personProfile(state, content, id);
    return [
      header(`${p.heading} · ${p.rankLabel}${p.age !== null ? ` · ${p.age}세` : ""}`),
      ...[p.look, p.reputation].filter((x): x is string => !!x),
      ...(p.traits.length ? [`보이는 모습: ${p.traits.join(" · ")}`] : []),
      "",
      ...(p.attitude
        ? [
            "나에 대한 태도 (마지막으로 만났을 때)",
            ...p.attitude.map((x) => gaugeLine(x.label, x.value - RELATION_MIN, RELATION_MAX - RELATION_MIN, `${x.word} ${signed(x.value)}`)),
          ]
        : ["아직 직접 만나 본 적이 없습니다. 태도는 만나 봐야 압니다."]),
      ...(p.knowsMySecret ? ["", `이 사람은 내 비밀(${p.knowsMySecret})을 안다.`] : []),
      ...(p.offers.length ? ["", ...p.offers] : []),
      ...(p.facts.length ? ["", "이 인물에 대해 아는 것", ...p.facts.map((b) => `  [${b.source}] ${b.fact}`)] : []),
    ].join("\n");
  },
};

const factions: CommandDef = {
  id: "factions",
  name: "세력",
  aliases: ["factions"],
  description: "아는 세력 정보와 관계",
  run(ctx) {
    const o = factionOutlook(ctx.state, ctx.content);
    if (!o.own && o.others.length === 0) return [header("세력"), "아는 세력 정보가 없습니다."].join("\n");
    const lines = [header("세력")];
    if (o.own) {
      lines.push(`소속  ${o.own.name} · 분위기 ${o.own.moraleLabel} · 배급 ${o.own.rationLabel}`);
      const own = ctx.content.factions[playerOf(ctx).factionId]?.culture;
      if (own) {
        lines.push(`  규율 ${disciplineOf(ctx.content, playerOf(ctx).factionId).label} · ${own.summary}`);
        for (const r of own.rules) lines.push(`  - ${r}`);
        if (own.address) lines.push(`  호칭: ${own.address}`);
        if (own.punishment) lines.push(`  어기면: ${own.punishment}`);
      }
      const policy = buildPlayerView(ctx.state, ctx.content).policy;
      if (policy.length) lines.push(`  방침 ${policy.map((p) => `${p.label} ${p.option}`).join(" · ")}`);
      for (const p of o.own.plans) lines.push(`  ${p.label}: ${p.stage}${p.targetName ? ` (목표는 ${josa(p.targetName, "이라는/라는")} 말)` : ""}`);
      lines.push("");
    }
    for (const f of o.others) lines.push(`${f.name}  [${f.stance}] ${f.size}`, `  ${f.public}`);
    const news = (ctx.state.beliefs[ctx.state.playerId] ?? []).filter((b) => b.topic === WAR_TOPIC || b.topic === WAR_INTEL_TOPIC).slice(-5).reverse();
    lines.push("", "최근 전황 (들은 것)");
    lines.push(...(news.length ? news.map((b) => `  [${formatAgo(ctx.state.time, b.learnedAt)} · ${formatTime(b.learnedAt)} · ${BELIEF_SOURCE_LABELS[b.source]}] ${withKnownNames(ctx.state, ctx.content, beliefText(ctx.state, b))}`) : ["  들은 소식이 없습니다."]));
    return lines.join("\n");
  },
};

const mission: CommandDef = {
  id: "mission",
  name: "임무",
  aliases: ["mission"],
  description: "현재 임무와 목표, 지킬 약속",
  run(ctx) {
    const { state, content } = ctx;
    const active = activeMissionOf(state.missions, state.playerId);
    const ended = Object.values(state.missions)
      .filter((m) => m.assigneeId === state.playerId && m.status !== "active")
      .slice(-3);
    const lines = [header("임무")];
    if (active) {
      lines.push(active.title, active.briefing, `기한 ${formatTime(active.deadline)}${active.place ? ` · 장소 ${active.place.label}` : ""}`, "");
      // 빗나간 횟수도 (플레이 테스트 12: ?임무에 빗나감 횟수가 안 나왔다)
      active.requirements.forEach((r, i) => {
        const fails = active.fails?.[i] ?? 0;
        lines.push(`  - ${describeRequirement(content.scenario, r, active.progress[i] ?? 0)}${fails > 0 && (active.progress[i] ?? 0) < 1 ? ` (빗나감 ${fails}/${MISSION_CHECK_TRIES}${fails >= MISSION_CHECK_TRIES ? ", 닫힘" : ""})` : ""}`);
      });
      const loan = buildPlayerView(state, content).loan;
      if (loan.length) lines.push("", `빌린 장비 (반납): ${loan.join(", ")}`);
    } else {
      lines.push(state.characters[state.playerId]?.factionId && commanderOf(state, content) ? "수행 중인 임무가 없습니다. 상관에게 물어보세요." : "수행 중인 임무가 없습니다. 임무를 내릴 상관이 없습니다.");
      // 오늘 받을 수 있는 일감 (플레이 테스트 12)
      const offers = state.offers?.day === dayOf(state.time) && !heldOf(state.characters[state.playerId]) ? state.offers.templateIds.map((id) => content.missions[id]).filter((m) => !!m) : [];
      if (offers.length) lines.push("", "오늘 받을 수 있는 임무", ...offers.map((m) => `  ${maskUnknownNames(state, content, m!.title)}`));
    }
    // 진급까지 남은 것 (플레이 테스트 12: 진급이 막힌 까닭이 보이지 않았다)
    const missing = buildPlayerView(state, content).service.promotionMissing;
    if (missing) lines.push("", missing.length ? `진급까지  ${missing.join(" · ")}` : "진급 조건을 채웠다 (상관의 제안을 기다린다)");
    if (ended.length) lines.push("", "최근 임무", ...ended.map((m) => `  ${m.title} — ${missionStatusLabel(m)}`));
    // 약속 (12-160)·받아 준 부탁 (12-174)
    const promises = promiseLines(state, content);
    if (promises.length) lines.push("", "지킬 약속·부탁", ...promises.map((l) => `  ${l}`));
    // 다짐 (12-164): 임무 아래
    const vow = resolveLine(state, content);
    if (vow) lines.push("", `다짐  ${vow}`);
    return lines.join("\n");
  },
};

const ration: CommandDef = {
  id: "ration",
  name: "배급",
  aliases: ["ration"],
  description: "받은 배급, 무리 자원에 대해 아는 것",
  run(ctx) {
    const o = factionOutlook(ctx.state, ctx.content);
    if (!o.own) return [header("배급"), "배급을 받는 무리가 없습니다."].join("\n");
    return [
      header("배급"),
      `오늘 배급  ${o.own.rationLabel}`,
      "",
      `${o.own.name} 창고 사정 (거점에서 들리는 말)`,
      ...o.own.stock.map((s) => `  ${s.label.padEnd(4, "　")} ${s.level}`),
    ].join("\n");
  },
};

const rumors: CommandDef = {
  id: "rumors",
  name: "소문",
  aliases: ["rumors"],
  description: "최근 들은 소식과 소문",
  run(ctx) {
    // 소식(무리 안에서 전해 들은 것)과 소문을 함께 (12-238, 플레이 테스트 13: 우리 공세 결과가 소식이라 ?소문에 없었다)
    const heard = (ctx.state.beliefs[ctx.state.playerId] ?? []).filter((b) => b.source === "rumor" || b.source === "report").slice(-12).reverse();
    return [header("소문"), ...(heard.length ? heard.map((b) => `  [${formatAgo(ctx.state.time, b.learnedAt)}] (${BELIEF_SOURCE_LABELS[b.source]}) ${withKnownNames(ctx.state, ctx.content, beliefText(ctx.state, b))}`) : ["  들은 소식·소문이 없습니다."])].join("\n");
  },
};

/** 검색어 없이 보여 줄 최근 일지 수 */
export const JOURNAL_RECENT = 8;

const journal: CommandDef = {
  id: "journal",
  name: "일지",
  aliases: ["기록", "journal"],
  args: "[검색어]",
  description: "지난 일 기록 (검색어로 찾기)",
  run(ctx, args) {
    const query = args.trim();
    if (query && ctx.memoryHits) {
      return [
        header(`일지: ${query}`),
        ...(ctx.memoryHits.length ? ctx.memoryHits.map((h) => `  ${h.text.replace(/\s+/g, " ")}`) : ["  찾은 기억이 없습니다."]),
      ].join("\n");
    }
    // memory 색인이 없으면 현재 캐릭터의 요약 기록에서 단순 검색한다
    const entries = ctx.summaries.filter((s) => !query || s.text.includes(query));
    const shown = entries.slice(-JOURNAL_RECENT).reverse();
    const hiddenCount = entries.length - shown.length;
    return [
      header(query ? `일지: ${query}` : "일지"),
      ...(shown.length
        ? shown.map((s) => `  ${formatTime(s.time)}${s.kind === "scene" ? " [장면]" : ""}  ${s.text.replace(/\s+/g, " ")}`)
        : ["  기록이 없습니다."]),
      ...(hiddenCount > 0 ? ["", `최근 ${shown.length}개만 보여 줍니다 (전체 ${entries.length}개). 검색어로 찾을 수 있습니다: ${ctx.prefix ?? "!"}일지 검색어`] : []),

    ].join("\n");
  },
};

const chronicle: CommandDef = {
  id: "chronicle",
  name: "연대기",
  aliases: ["chronicle"],
  description: "죽은 캐릭터들의 기록",
  run(ctx) {
    const options = successionOptions(ctx.state, ctx.content);
    return [
      header("연대기"),
      ...formatChronicle(ctx.state, ctx.content),
      ...(options.length ? ["다음 캐릭터 후보", ...options.map((o) => `  ${o.id}  ${o.label} — ${o.detail}`)] : []),
      ...(storyEnded(ctx.state, ctx.content) ? [`다음 캐릭터로 이어 갈 수 없습니다 (${ctx.content.roles[ctx.state.scenarioRole]?.scenario?.heirs === false ? "이 시나리오는 다음 캐릭터로 이어 가지 않습니다" : "이어 갈 만한 사람을 만나지 못했습니다"}). 이야기는 여기서 끝났습니다. 새 게임에서 열린 시나리오를 고를 수 있습니다.`] : []),
    ]
      .join("\n")
      .trimEnd();
  },
};

function burdenLine(gear: NonNullable<PlayerView["gear"]>): string {
  return `소지품 무게  ${gear.weight}/${gear.capacity}kg${gear.burden === 2 ? " · 너무 무거움 (옮겨 가지 못합니다)" : gear.burden === 1 ? " · 무거움 (판정이 불리합니다)" : ""}`;
}

const gear: CommandDef = {
  id: "gear",
  name: "장비",
  aliases: ["무기", "gear"],
  description: "손에 든 무기, 입은 방어구, 탄약·내구도, 소지품 무게",
  run(ctx) {
    const view = buildPlayerView(ctx.state, ctx.content);
    const g = view.gear;
    if (!g) return [header("장비"), "이 월드에는 장비 규칙이 없습니다."].join("\n");
    const line = (x: NonNullable<typeof g.weapon>) =>
      [`${x.slotLabel.padEnd(2, "　")}  ${x.name}${x.ammo ? ` · ${x.ammo}` : ""}${x.durability ? ` · 내구도 ${x.durability.left}/${x.durability.max}` : ""}`, ...(x.detail ? [`      ${x.detail}`] : [])];
    return [
      header("장비"),
      ...(g.weapon ? line(g.weapon) : ["손    맨손"]),
      ...g.armor.flatMap(line),
      "",
      burdenLine(g),
      ...(view.loan.length ? [`빌린 장비 (반납): ${view.loan.join(", ")}`] : []),
    ].join("\n");
  },
};

/** 검색어 없이 보여 줄 행적·아는 것 수 */
const LIST_RECENT = 15;

const deeds: CommandDef = {
  id: "deeds",
  name: "행적",
  aliases: ["deeds"],
  description: "내가 한 일 중 평판에 남는 것 (본 사람은 내가 아는 사람만)",
  run(ctx) {
    const list = buildPlayerView(ctx.state, ctx.content).deeds;
    const shown = list.slice(0, LIST_RECENT);
    return [
      header(`행적 (${list.length})`),
      ...(shown.length
        ? shown.map((d) => `  [${d.tagLabels.join("·")}] ${d.summary}${d.visibleWitnesses.length ? ` — 본 사람: ${d.visibleWitnesses.join(", ")}` : ""}`)
        : ["  남은 행적이 없습니다."]),
      ...(list.length > shown.length ? ["", `최근 ${shown.length}개만 보여 줍니다.`] : []),
    ].join("\n");
  },
};

const beliefs: CommandDef = {
  id: "beliefs",
  name: "아는것",
  aliases: ["아는", "믿음", "beliefs"],
  args: "[검색어]",
  description: "알고 있다고 믿는 것 전체 (보고 들은 것, 소문). 검색어로 찾기",
  run(ctx, args) {
    // "?아는 것"처럼 띄어 쓰면 "것"이 검색어로 들어온다
    const query = args.trim().replace(/^것(\s+|$)/, "");
    const all = buildPlayerView(ctx.state, ctx.content).beliefs;
    const list = query ? all.filter((b) => b.fact.includes(query)) : all;
    const shown = list.slice(0, LIST_RECENT);
    return [
      header(query ? `아는 것: ${query}` : `아는 것 (${all.length})`),
      ...(shown.length ? shown.map((b) => `  [${b.learnedLabel} · ${b.sourceLabel}] ${b.fact}`) : ["  없습니다."]),
      ...(list.length > shown.length ? ["", `최근 ${shown.length}개만 보여 줍니다 (전체 ${list.length}개). 검색어로 찾을 수 있습니다: ${ctx.prefix ?? "!"}아는것 검색어`] : []),
    ].join("\n");
  },
};

const ties: CommandDef = {
  id: "ties",
  name: "사이",
  aliases: ["인물사이", "ties"],
  description: "알게 된 인물들 사이의 관계",
  run(ctx) {
    const list = buildPlayerView(ctx.state, ctx.content).ties;
    return [header("인물 사이"), ...(list.length ? list.map((t) => `  ${t.text}`) : ["  아는 것이 없습니다."])].join("\n");
  },
};

const settings: CommandDef = {
  id: "settings",
  name: "설정",
  aliases: ["options", "settings"],
  description: "이 게임의 설정 (성인 콘텐츠, 대화 형식)",
  run(ctx) {
    const o = ctx.state.options;
    return [
      header("설정"),
      `성인 콘텐츠  ${o.mature ? "켬" : "끔"}`,
      `대화 형식    ${DIALOGUE_STYLE_LABELS[o.dialogue]}${o.dialogue === "script" ? " (대사를 \"이름: 대사\" 줄로 뗍니다)" : " (대사를 서술 속에 녹입니다)"}`,
      "",
      "바꾸려면 채팅으로 말하거나(예: \"대화 형식을 대본으로\") 상태 화면의 톱니바퀴를 누릅니다.",
    ].join("\n");
  },
};

const memo: CommandDef = {
  id: "memo",
  name: "메모",
  aliases: ["memo", "note"],
  args: "[내용 | 고침 내용 | 지움]",
  description: "메모 읽기 (메모장이 있을 때). 내용을 붙이면 적는다",
  run(ctx) {
    const me = ctx.state.characters[ctx.state.playerId]!;
    const access = memoAccess(ctx.content, me);
    if (!access.read) return [header("메모"), "메모장이 없습니다."].join("\n");
    const text = ctx.state.memos[me.id] ?? "";
    const p = ctx.prefix ?? "!";
    return [
      header("메모"),
      text || "(비어 있음)",
      "",
      access.write
        ? `적기: ${p}메모 내용 (새 줄로 덧붙임) · ${p}메모 고침 내용 (통째로 바꿈) · ${p}메모 지움. 상태 화면의 메모 탭에서도 적을 수 있습니다.`
        : "펜이나 연필이 없어 읽기만 할 수 있습니다.",
    ].join("\n");
  },
};

const help: CommandDef = {
  id: "help",
  name: "도움말",
  aliases: ["help", "?"],
  description: "명령어 목록",
  run: (ctx) =>
    [
      header("명령어"),
      ...COMMANDS.map((c) => `${ctx.prefix ?? "!"}${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(14) + " " + c.description),
      "",
      "행동은 명령어가 아니라 자연어로 입력하세요. 명령어는 시간을 쓰지 않습니다.",
    ].join("\n"),
};

/** 명령어 정의 (데이터). 이름과 별칭은 시나리오별로 바꿀 수 있게 둔다 */
export const COMMANDS: readonly CommandDef[] = [
  status,
  inventory,
  map,
  time,
  people,
  factions,
  mission,
  ration,
  rumors,
  gear,
  deeds,
  beliefs,
  ties,
  journal,
  chronicle,
  settings,
  memo,
  help,
];

export const COMMAND_PREFIX = "!";
/**
 * 정보 명령어로 받는 접두사. Claude 앱은 줄 맨 앞의 "!"를 셸 명령으로 가로채므로 MCP 모드는 "?"를 쓴다.
 * 두 모드 모두 둘 다 받는다 (전각 문자 포함)
 */
export const COMMAND_PREFIXES = ["!", "?", "！", "？"] as const;

/** 플레이 모드별로 안내에 보여 주는 접두사 */
export function commandPrefixFor(mode: "web" | "mcp"): string {
  return mode === "mcp" ? "?" : "!";
}

export function isCommand(input: string): boolean {
  const t = input.trim();
  return COMMAND_PREFIXES.some((p) => t.startsWith(p));
}

/** 접두사를 뗀 명령어 본문 ("?인물 강태호" → "인물 강태호") */
export function stripCommandPrefix(input: string): string {
  const t = input.trim();
  const p = COMMAND_PREFIXES.find((x) => t.startsWith(x));
  return (p ? t.slice(p.length) : t).trim();
}

/** "!인물 강태호"(또는 "?인물 강태호") → 명령어 실행 결과 텍스트. 알 수 없는 명령어면 가까운 것을 제안한다 */
export function runCommand(input: string, ctx: CommandContext, commands: readonly CommandDef[] = COMMANDS): string {
  const body = stripCommandPrefix(input);
  const p = ctx.prefix ?? "!";
  const [word = "", ...rest] = body.split(/\s+/);
  const args = rest.join(" ");
  // 접두사만 쳤으면 ("?") 도움말
  const command = word ? commands.find((c) => c.name === word || c.aliases.includes(word)) : commands.find((c) => c.id === "help");
  if (command) return command.run(ctx, args);

  const names = commands.flatMap((c) => [c.name, ...c.aliases].map((n) => ({ n, c })));
  const best = names.map((x) => ({ ...x, d: editDistance(word, x.n) })).sort((a, b) => a.d - b.d)[0];
  const suggestion = best && best.d <= Math.max(1, Math.floor(word.length / 2)) ? ` 혹시 ${p}${best.c.name} 인가요?` : "";
  return `알 수 없는 명령어: ${p}${word || ""}.${suggestion} 전체 목록은 ${p}도움말`;
}
