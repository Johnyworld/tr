/**
 * 전쟁이 남긴 일 (docs/war-parties-plan.md 파트 13, 12-322). 수색·수비·의무실·보수팀이 맡는 일:
 * - 계기(warCauses): 부서진 시설(우리 땅), 의무실 부상자, 하루 안의 교전 흔적(우리 땅·맞닿은 곳), 적 부대가 든 우리 땅·노리는 우리 구역.
 *   그 일이 남아 있는 날에만 그 직분의 전쟁 임무(war_cause)가 오늘의 후보에 오르고 직분 몫 자리에 먼저 선다. 자리는 그 일이 있는 구역
 * - 의무실 부상자(13-2): 우리 무리가 교전에서 사상자를 내면 일부(최대 셋)가 거점 의무실에 이름 없는 부상자(중상)로 들어온다.
 *   경상 이하로 나으면 제자리로 돌아가고(인원·전투원 +1), 사흘 동안 낫지 않으면 절반이 숨지고 나머지는 혼자 일어난다(인원 +1).
 *   사상자는 교전에서 이미 빠졌으니, 돌보는 사람이 없으면 무리 셈은 그대로이거나 조금 낫다
 */
import type { Content } from "../content/schemas.ts";
import type { Clash, GameState } from "../game/state.ts";
import type { MissionInstance } from "../game/missions.ts";
import { hostileFaction, ownedBy, baseOfNow } from "../rules/home.ts";
import { placesIn } from "../rules/place.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { harmTrack } from "../scenario/scenario.ts";
import { partyZoneAt } from "../sim/parties.ts";
import { neighbors } from "../sim/war.ts";
import { hearNews } from "../rules/news.ts";
import { josa } from "../text.ts";
import { changeCondition } from "./body.ts";
import { createExtraCharacter } from "./extras.ts";
import { facilityOf } from "./facilities.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

export type WarCause = "repair" | "wounded" | "traces" | "threat";

/** 의무실 부상자가 홀로 버티는 날 수 */
export const WOUNDED_DAYS = 3;
/** 교전 하나에서 의무실에 드는 부상자 수의 상한 */
const WOUNDED_MAX = 3;

/** 이 무리에 지금 남은 전쟁의 일과 그 구역 (없으면 빈 객체) */
export function warCauses(state: GameState, content: Content, factionId: string | null | undefined): Partial<Record<WarCause, string>> {
  if (!factionId) return {};
  const out: Partial<Record<WarCause, string>> = {};
  const wreck = Object.entries(state.wrecked).sort(([a], [b]) => a.localeCompare(b)).find(([z, ids]) => ids.length > 0 && ownedBy(state, z, factionId));
  if (wreck) out.repair = wreck[0];
  const hurt = state.wounded.find((w) => w.faction === factionId && !state.characters[w.id]?.dead);
  if (hurt) out.wounded = hurt.zone;
  const ours = (z: string) => ownedBy(state, z, factionId) || neighbors(content, z).some((n) => ownedBy(state, n, factionId));
  // 상대가 있는 교전만: 빈 땅을 차지한 일(occupy)에는 수습할 싸움터가 없다 (PT33 약탈자)
  const trace = [...state.recentClashes].reverse().find((r) => state.time - r.at <= MINUTES_PER_DAY && r.clash.kind !== "occupy" && !!r.clash.defender && (r.clash.attacker === factionId || r.clash.defender === factionId) && ours(r.clash.zone));
  if (trace) out.traces = trace.clash.zone;
  const party = state.parties.find((p) => p.size > 0 && hostileFaction(state, content, p.faction) && ownedBy(state, partyZoneAt(p, state.time), factionId));
  const threatZone = party ? partyZoneAt(party, state.time) : null;
  if (threatZone) out.threat = threatZone;
  else {
    const aimed = Object.entries(state.clocks).sort(([a], [b]) => a.localeCompare(b)).find(([, c]) => c.factionId !== factionId && hostileFaction(state, content, c.factionId) && ownedBy(state, c.target, factionId) && c.filled * 2 >= c.max);
    if (aimed) out.threat = aimed[1].target;
  }
  return out;
}

/** 교전에서 우리 무리가 낸 사상자 일부를 거점 의무실의 부상자로 (13-2). 주인공이 무리에 속할 때만 */
export function woundedToInfirmary(ctx: ToolContext, clashes: readonly Clash[]): ToolDisplayEvent[] {
  const { content } = ctx;
  const out: ToolDisplayEvent[] = [];
  for (const clash of clashes) {
    const state = ctx.store.getState();
    const mine = state.characters[state.playerId]?.factionId;
    if (!mine || state.characters[state.playerId]?.dead) return out;
    // 분대 가로막기의 손실은 분대원의 다침이다 (보고에서)
    const losses = clash.squad ? 0 : clash.attacker === mine ? clash.attackerLosses : clash.defender === mine ? clash.defenderLosses : 0;
    if (losses <= 0) continue;
    const base = baseOfNow(state, content, mine);
    const templateId = content.factions[mine]?.party_extra ?? Object.values(content.extras).find((t) => t.faction === mine)?.id;
    const template = templateId ? content.extras[templateId] : undefined;
    if (!base || !template) continue;
    const care = placesIn(state, content, base).find((p) => p.kinds.includes("care"))?.id ?? null;
    const track = harmTrack(content.scenario);
    const serious = track.levels.findIndex((l) => l.id === (content.scenario.recovery?.natural_max_level ?? "serious"));
    const ids: string[] = [];
    for (let i = 0; i < Math.min(WOUNDED_MAX, Math.ceil(losses / 2)); i++) {
      const now = ctx.store.getState();
      const id = `ex_${now.nextExtraNo}`;
      const character = createExtraCharacter(content, template, { id, label: "의무실 부상자", zone: base, time: now.time, usedNames: new Set(Object.values(now.characters).map((c) => c.name)) }, ctx.rng);
      character.extra = { ...character.extra!, place: care };
      character.inventory = {};
      ctx.store.append({ type: "extra_spawned", character, unseen: true });
      if (serious > 0) changeCondition(ctx, id, track.id, serious, "harm", `${content.locations[clash.zone]?.name ?? clash.zone}의 교전`);
      ids.push(id);
    }
    if (!ids.length) continue;
    ctx.store.append({ type: "wounded_arrived", faction: mine, zone: base, ids });
    const where = care ? (placesIn(state, content, base).find((p) => p.id === care)?.name ?? "의무실") : (content.locations[base]?.name ?? base);
    out.push(...hearNews(ctx, { fact: `${content.locations[clash.zone]?.name ?? clash.zone}의 교전에서 다친 사람 ${ids.length}명이 ${where}에 실려 왔다고 한다.`, factions: [mine], showOursOnly: true }));
  }
  return out;
}

/** 의무실 부상자를 살핀다 (시간이 흐른 뒤마다): 경상 이하로 나았으면 돌아가고, 사흘 동안 낫지 않았으면 절반이 숨진다 */
export function runInfirmary(ctx: ToolContext): ToolDisplayEvent[] {
  const { content } = ctx;
  const out: ToolDisplayEvent[] = [];
  const track = harmTrack(content.scenario);
  const light = track.levels.findIndex((l) => l.id === "light");
  const fatal = track.levels.findIndex((l) => l.fatal);
  for (const w of [...ctx.store.getState().wounded]) {
    const state = ctx.store.getState();
    const c = state.characters[w.id];
    const at = c ? track.levels.findIndex((l) => l.id === c.conditions[track.id]) : -1;
    const mine = state.characters[state.playerId]?.factionId === w.faction;
    if (!c || c.dead) {
      ctx.store.append({ type: "wounded_settled", id: w.id, outcome: "died" });
      continue;
    }
    if (light >= 0 && at <= light) {
      ctx.store.append({ type: "wounded_settled", id: w.id, outcome: "recovered" });
      if (mine) out.push(...hearNews(ctx, { fact: "의무실에 누워 있던 부상자 하나가 털고 일어나 제자리로 돌아갔다고 한다.", factions: [w.faction], showOursOnly: true }));
      continue;
    }
    if (state.time - w.at < WOUNDED_DAYS * MINUTES_PER_DAY) continue;
    if (ctx.rng() < 0.5 && fatal > at) {
      changeCondition(ctx, w.id, track.id, fatal - at, "harm", "돌보는 손이 닿지 않았다");
      ctx.store.append({ type: "wounded_settled", id: w.id, outcome: "died" });
      if (mine) out.push(...hearNews(ctx, { fact: "의무실에 누워 있던 부상자 하나가 끝내 숨졌다고 한다.", factions: [w.faction], showOursOnly: true }));
    } else ctx.store.append({ type: "wounded_settled", id: w.id, outcome: "survived" });
  }
  return out;
}

/** 해낸 전쟁 임무의 결과 (보고할 때): 보수는 부서진 시설 하나를 다시 세우고, 의무실 돌봄은 부상자를 한 단계씩 낫게 한다 */
export function settleWarCause(ctx: ToolContext, mission: MissionInstance, cause: WarCause | undefined, outcome: "success" | "partial" | "failed"): string[] {
  const { content, store } = ctx;
  const zone = mission.place?.zone;
  if (!cause || !zone || outcome === "failed") return [];
  if (cause === "repair" && outcome === "success") {
    const id = store.getState().wrecked[zone]?.[0];
    const f = id ? facilityOf(content, id) : undefined;
    if (!id || !f) return [];
    store.append({ type: "facility_built", zone, facility: id });
    if (f.effects.fort) store.append({ type: "zone_fortified", zone, delta: f.effects.fort });
    return [`${content.locations[zone]?.name ?? zone}의 ${josa(f.label, "을/를")} 다시 세웠다.`];
  }
  if (cause === "wounded") {
    const track = harmTrack(content.scenario);
    const hurt = store.getState().wounded.filter((w) => w.zone === zone && !store.getState().characters[w.id]?.dead);
    const tended = outcome === "success" ? hurt : hurt.slice(0, 1);
    for (const w of tended) changeCondition(ctx, w.id, track.id, -1, "care", `의무실 돌봄: ${mission.title}`);
    return tended.length ? [`의무실 부상자 ${tended.length}명을 돌봤다 (나으면 제자리로 돌아간다).`] : [];
  }
  return [];
}
