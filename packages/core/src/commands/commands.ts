import { josa } from "../text.ts";
import { growthLine, skillLines } from "../engine/growth.ts";
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import type { TurnSummary } from "../engine/log.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { activeMissionOf, commanderOf, daysServed, MISSION_STATUS_LABELS } from "../game/missions.ts";
import { NEUTRAL_RELATION, RELATION_AXES, RELATION_AXIS_LABELS, RELATION_MAX, RELATION_MIN, relationLabel } from "../game/reputation.ts";
import { dayOf, formatTime, minuteOfDay, SEGMENT_LABELS, segmentOf } from "../rules/time.ts";
import { conditionPenalty, rankLabel, shownLevel } from "../scenario/scenario.ts";
import { describeRequirement } from "../engine/missionTools.ts";
import { editDistance, gauge, gaugeLine, header, signed } from "./format.ts";
import { factionOutlook, WAR_TOPIC, zoneOutlook } from "../engine/warTools.ts";
import { formatChronicle, successionOptions } from "../engine/succession.ts";
import { seasonAt, seasonLabel } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";

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
  return role?.rank === player.rank ? role.label : rankLabel(ctx.content.scenario, player.rank);
}

function clockLine(state: GameState) {
  const m = minuteOfDay(state.time);
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${dayOf(state.time)}일차 · ${hhmm} · ${SEGMENT_LABELS[segmentOf(state.time)]} · 복무 ${daysServed(state.time, state.runStartedAt) + 1}일째`;
}

/** 관계 축 하나를 게이지로 (-5 ~ +5를 0 ~ 10으로) */
function relationGauge(value: number) {
  return gauge(value - RELATION_MIN, RELATION_MAX - RELATION_MIN);
}

const status: CommandDef = {
  id: "status",
  name: "상태",
  aliases: ["스탯", "status"],
  description: "능력, 스킬, 경험치, 몸 상태, 소속과 등급, 평판",
  run(ctx) {
    const { state, content } = ctx;
    const scenario = content.scenario;
    const player = playerOf(ctx);
    const lines = [header(`${player.name} · ${roleLabelOf(ctx)}`), clockLine(state), ""];
    lines.push(scenario.stats.map((s) => `${s.label} ${signed(player.stats[s.id] ?? 0)}`).join("   "), "");
    lines.push(...skillLines(scenario, player.skills));
    const growth = growthLine(scenario, player);
    if (growth) lines.push(growth);
    lines.push("");
    for (const track of scenario.condition_tracks) {
      // 숨은 단계(잠복기)는 캐릭터가 모르므로 보이는 단계로
      const shown = shownLevel(track, player.conditions[track.id]);
      const index = track.levels.indexOf(shown);
      lines.push(gaugeLine(track.label, index, track.levels.length - 1, shown.label));
    }
    const penalty = conditionPenalty(scenario, player);
    if (penalty !== 0) lines.push(`판정 보정 ${signed(penalty)}`);
    lines.push("");
    const commanderId = commanderOf(state, content);
    const commander = commanderId ? state.characters[commanderId] : undefined;
    lines.push(`소속  ${roleLabelOf(ctx)}${commander ? ` (상관 ${commander.name})` : ""}`);
    const trust = commander ? (state.perceived[commander.id]?.trust ?? 0) : null;
    lines.push(
      `평판  공적 ${player.merit} · 불복종 ${player.disobedience}회` +
        (trust !== null && commander ? ` · ${commander.name}의 신뢰 ${relationLabel(trust)}` : ""),
    );
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
      "",
      NOT_YET("무게", "자원 단계(9)"),
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
      ...z.adjacent.map((a) => `  ${a.name} · ${a.owner}`),
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
    const known = (state.known[state.playerId] ?? []).filter((id) => state.characters[id]);
    if (!args) {
      if (known.length === 0) return [header("인물"), "아는 인물이 없습니다."].join("\n");
      return [
        header("인물"),
        ...known.map((id) => {
          const c = state.characters[id]!;
          const r = state.perceived[id] ?? NEUTRAL_RELATION;
          const here = state.scene.present.includes(id) ? " · 함께 있음" : "";
          return `${c.name}  ${rankLabel(content.scenario, c.rank)}${c.dead ? " · 사망" : ""}${here}  (신뢰 ${relationLabel(r.trust)})`;
        }),
        "",
        "자세히: !인물 이름",
      ].join("\n");
    }
    const query = args.trim();
    const id = known.find((k) => state.characters[k]!.name === query || k === query) ??
      known.find((k) => state.characters[k]!.name.includes(query));
    if (!id) return `아는 인물 중에 ${josa(`"${query}"`, "이/가")} 없습니다. 목록: !인물`;
    const c = state.characters[id]!;
    const npc = content.npcs[id];
    const met = state.perceived[id] !== undefined;
    const r = state.perceived[id] ?? NEUTRAL_RELATION;
    const facts = (state.beliefs[state.playerId] ?? []).filter((b) => b.fact.includes(c.name)).slice(-5);
    return [
      header(`${c.name} · ${rankLabel(content.scenario, c.rank)}`),
      ...(npc ? [npc.look, npc.reputation] : []),
      "",
      ...(met
        ? [
            "나에 대한 태도 (마지막으로 만났을 때)",
            ...RELATION_AXES.map((axis) =>
              gaugeLine(RELATION_AXIS_LABELS[axis], r[axis] - RELATION_MIN, RELATION_MAX - RELATION_MIN, `${relationLabel(r[axis])} ${signed(r[axis])}`),
            ),
          ]
        : ["아직 직접 만나 본 적이 없다. 태도는 만나 봐야 안다."]),
      ...(facts.length ? ["", "이 인물에 대해 아는 것", ...facts.map((b) => `  [${BELIEF_SOURCE_LABELS[b.source]}] ${b.fact}`)] : []),
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
      for (const p of o.own.plans) lines.push(`  ${p.label}: ${p.stage}${p.targetName ? ` (목표는 ${josa(p.targetName, "이라는/라는")} 말)` : ""}`);
      lines.push("");
    }
    for (const f of o.others) lines.push(`${f.name}  [${f.stance}] ${f.size}`, `  ${f.public}`);
    const news = (ctx.state.beliefs[ctx.state.playerId] ?? []).filter((b) => b.topic === WAR_TOPIC).slice(-5).reverse();
    lines.push("", "최근 전황 (들은 것)");
    lines.push(...(news.length ? news.map((b) => `  [${formatTime(b.learnedAt)} · ${BELIEF_SOURCE_LABELS[b.source]}] ${b.fact}`) : ["  들은 소식이 없습니다."]));
    return lines.join("\n");
  },
};

const mission: CommandDef = {
  id: "mission",
  name: "임무",
  aliases: ["mission"],
  description: "현재 임무와 목표",
  run(ctx) {
    const { state, content } = ctx;
    const active = activeMissionOf(state.missions, state.playerId);
    const ended = Object.values(state.missions)
      .filter((m) => m.assigneeId === state.playerId && m.status !== "active")
      .slice(-3);
    const lines = [header("임무")];
    if (active) {
      lines.push(active.title, active.briefing, `기한 ${formatTime(active.deadline)}`, "");
      active.requirements.forEach((r, i) => lines.push(`  - ${describeRequirement(content.scenario, r, active.progress[i] ?? 0)}`));
    } else {
      lines.push("수행 중인 임무가 없습니다. 상관에게 물어보세요.");
    }
    if (ended.length) lines.push("", "최근 임무", ...ended.map((m) => `  ${m.title} — ${MISSION_STATUS_LABELS[m.status]}`));
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
  description: "최근 들은 소문",
  run(ctx) {
    const heard = (ctx.state.beliefs[ctx.state.playerId] ?? []).filter((b) => b.source === "rumor").slice(-10).reverse();
    return [header("소문"), ...(heard.length ? heard.map((b) => `  ${b.fact}`) : ["  들은 소문이 없습니다."])].join("\n");
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
      ...(hiddenCount > 0 ? ["", `최근 ${shown.length}개만 보여 줍니다 (전체 ${entries.length}개). 검색어로 찾을 수 있습니다: !일지 검색어`] : []),

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
    ]
      .join("\n")
      .trimEnd();
  },
};

const help: CommandDef = {
  id: "help",
  name: "도움말",
  aliases: ["help", "?"],
  description: "명령어 목록",
  run: () =>
    [
      header("명령어"),
      ...COMMANDS.map((c) => `!${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(14) + c.description),
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
  journal,
  chronicle,
  help,
];

export const COMMAND_PREFIX = "!";

export function isCommand(input: string): boolean {
  return input.trim().startsWith(COMMAND_PREFIX);
}

/** "!인물 강태호" → 명령어 실행 결과 텍스트. 알 수 없는 명령어면 가까운 것을 제안한다 */
export function runCommand(input: string, ctx: CommandContext, commands: readonly CommandDef[] = COMMANDS): string {
  const body = input.trim().replace(/^!/, "").trim();
  const [word = "", ...rest] = body.split(/\s+/);
  const args = rest.join(" ");
  const command = commands.find((c) => c.name === word || c.aliases.includes(word));
  if (command) return command.run(ctx, args);

  const names = commands.flatMap((c) => [c.name, ...c.aliases].map((n) => ({ n, c })));
  const best = names.map((x) => ({ ...x, d: editDistance(word, x.n) })).sort((a, b) => a.d - b.d)[0];
  const suggestion = best && best.d <= Math.max(1, Math.floor(word.length / 2)) ? ` 혹시 !${best.c.name} 인가요?` : "";
  return `알 수 없는 명령어: !${word || ""}.${suggestion} 전체 목록은 !도움말`;
}
