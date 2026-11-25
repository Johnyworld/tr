/**
 * 세계가 움직인 느낌 (12-242). 순찰조를 단위로 움직이는 시뮬레이션 대신, 이미 있는 상태(교전 기록·땅 주인·들킴)를
 * 플레이어가 원인과 결과로 알아챌 수 있게 드러낸다:
 * 1. 흔적: 교전이 있던 구역에 며칠 남는 것 (GM 상태의 구역 줄)
 * 2. 결과가 사람에게: 사상자 한 명마다 낮은 확률로 이름 있는 대원 하나가 다치거나 죽는다. 공들인 관계는 첫 죽음을 봐준다 (공통 규칙 8의 invested).
 *    우리 무리면 소식으로 듣고, 남의 무리면 만난 적 있는 사람만 소문으로 (원칙 4)
 * 3. 원인 있는 만남: 길 위의 위험이 그 길의 최근 교전·주인공이 들킨 일로 한 단계 오르고, 열린 길 위 이야기에 그 까닭을 붙인다
 */
import type { Content } from "../content/schemas.ts";
import type { Clash, GameState } from "../game/state.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { invested, protectedFromWorld } from "../rules/company.ts";
import { harmTrack } from "../scenario/scenario.ts";
import { josa } from "../text.ts";
import { changeCondition } from "./body.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { hearNews } from "../rules/news.ts";
import { reduceHarm } from "../rules/damage.ts";

const felt = (content: Content) => content.scenario.war?.felt;

/** 1. 지금 구역에 남은 교전의 흔적 한 줄 (없으면 null) */
export function tracesHere(state: GameState, content: Content): string | null {
  const f = felt(content);
  if (!f || !state.playerZone) return null;
  const recent = state.recentClashes.filter((r) => r.clash.zone === state.playerZone && state.time - r.at <= f.trace_days * MINUTES_PER_DAY).at(-1);
  const text = recent ? f.traces[recent.clash.kind] : undefined;
  if (!text || !recent) return null;
  const hours = (state.time - recent.at) / 60;
  const when = hours < 12 ? "몇 시간 전" : hours < 36 ? "어제" : "이틀쯤 전";
  return `교전의 흔적: ${when} ${text}. 본 대로 서술한다 (누가 이겼는지는 주인공이 아는 만큼만).`;
}

/** 2. 교전의 사상자 가운데 이름 있는 대원에게 내려온다. 알릴 것 */
export function casualtiesToPeople(ctx: ToolContext, clashes: readonly Clash[]): ToolDisplayEvent[] {
  const f = felt(ctx.content)?.named;
  if (!f) return [];
  const out: ToolDisplayEvent[] = [];
  for (const clash of clashes) {
    for (const [faction, losses] of [[clash.attacker, clash.attackerLosses], [clash.defender, clash.defenderLosses]] as const) {
      if (!faction) continue;
      // 분대 가로막기의 우리 쪽 손실은 분대원의 다침이다 (PT34 붉은연합 분대장: 분대 밖 사람이 다쳤다고 들렸다)
      if (clash.squad && faction === ctx.store.getState().characters[ctx.store.getState().playerId]?.factionId) continue;
      for (let i = 0; i < losses; i++) {
        if (ctx.rng() >= f.chance) continue;
        const state = ctx.store.getState();
        const pool = Object.values(ctx.content.npcs).filter((n) => n.faction === faction && state.characters[n.id]?.factionId === faction && !protectedFromWorld(state, ctx.content, n.id));
        if (!pool.length) continue;
        const who = pool[Math.floor(ctx.rng() * pool.length)]!.id;
        out.push(...hurtNamed(ctx, who, faction, ctx.rng() < f.death, ctx.content.locations[clash.zone]?.name ?? clash.zone));
      }
    }
  }
  return out;
}

function hurtNamed(ctx: ToolContext, id: string, faction: string, death: boolean, place: string): ToolDisplayEvent[] {
  const state = ctx.store.getState();
  const track = harmTrack(ctx.content.scenario);
  const c = state.characters[id]!;
  const at = track.levels.findIndex((l) => l.id === c.conditions[track.id]);
  const fatal = track.levels.findIndex((l) => l.fatal);
  const serious = track.levels.findIndex((l) => l.id === ctx.content.scenario.recovery?.natural_max_level);
  const keep = death && invested(state, ctx.content, id) && !(state.sparedOnce ?? []).includes(id);
  let fact: string;
  const name = playerCalls(state, ctx.content, id);
  if (death && !keep && fatal > at) {
    changeCondition(ctx, id, track.id, fatal - at, "harm", `${place}의 교전`);
    fact = `${josa(name, "이/가")} ${place}의 교전에서 죽었다고 한다.`;
  } else {
    if (keep) ctx.store.append({ type: "npc_spared", npcId: id });
    const target = keep || ctx.rng() < 0.5 ? Math.max(serious, at + 1) : at + 1;
    const raw = Math.max(1, Math.min(target, (fatal >= 0 ? fatal : track.levels.length) - 1) - at);
    // 다침은 피해의 셈을 거친다 (공통 규칙 13: 그 인물의 레벨만큼 버틴다). 봐준 것은 정해진 결과라 그대로
    const steps = keep ? raw : reduceHarm(ctx, { who: id, raw, attack: true, shareable: false, cause: `${place}의 교전`, track: track.id }).steps;
    if (steps <= 0) return [];
    changeCondition(ctx, id, track.id, steps, "harm", `${place}의 교전`);
    fact = keep ? `${josa(name, "이/가")} ${place}의 교전에서 크게 다쳤지만 살아 돌아왔다고 한다.` : `${josa(name, "이/가")} ${place}의 교전에서 다쳤다고 한다.`;
  }
  // 우리 무리면 소식으로, 남의 무리면 만난 적 있는 사람만 소문으로 (공통 규칙 14)
  return hearNews(ctx, { fact, factions: [faction], person: id });
}

/** 3. 지난 길의 위험을 올리는 까닭 (없으면 null): 하루 안에 그 길 끝에서 교전이 있었거나, 주인공이 그 땅 주인에게 들켰다 */
export function routeCause(state: GameState, content: Content): string | null {
  if (!state.lastRoute) return null;
  const ends = [state.lastRoute.from, state.lastRoute.to];
  const day = MINUTES_PER_DAY;
  if (state.recentClashes.some((r) => ends.includes(r.clash.zone) && state.time - r.at <= day)) return "근처에서 교전이 있은 뒤라 길에 무장한 사람이 잦다";
  const owners = ends.map((z) => state.zones[z]?.owner).filter((o): o is string => !!o);
  const spotted = Object.values(state.deeds).some((d) => d.actorId === state.playerId && d.tags.includes("trespass") && state.time - d.at <= day && owners.some((o) => d.summary.startsWith(content.factions[o]?.name ?? "\\u0000")));
  if (spotted) return "들킨 다음 날이라 그 땅의 순찰이 잦다";
  void dayOf;
  return null;
}
