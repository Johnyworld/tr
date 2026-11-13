import type { HistoryPart } from "../game/background.ts";
import { describeHistoryPart, historyFlags } from "../game/background.ts";
import { sentence } from "../text.ts";
import { createExtraCharacter } from "./extras.ts";
import type { ToolContext } from "./toolkit.ts";

/**
 * 배경 부품을 세이브의 역사로 남긴다 (기획서 12.6). 새 세계를 만들 때 한 번.
 * - 플래그: 배경으로 열리는 이야기 (bg_*)
 * - 주인공의 기억: 부품마다 한 문장 (주인공이 아는 대로)
 * - 원수·가해자가 인물이면 주인공은 그 이름을 안다. 원수가 주인공을 알면(knows_you) 그쪽의 신뢰가 낮다
 * - 살아 있는 가족은 그 구역에서 기다리는 연고 동행, 찾는 사람은 코드가 아무 구역에나 둔다 (아무도 모른다)
 * - 빚은 월드가 정한 크기로
 */
export function applyBackground(ctx: ToolContext, parts: readonly HistoryPart[]): void {
  const { store, content, rng } = ctx;
  if (parts.length === 0) return;
  const entries: { part: HistoryPart; characterId?: string }[] = [];
  const spawn = (template: string, label: string, zone: string): string | null => {
    const t = content.extras[template];
    if (!t) return null;
    const state = store.getState();
    const id = `ex_${state.nextExtraNo}`;
    const usedNames = new Set(Object.values(state.characters).map((c) => c.name));
    store.append({ type: "extra_spawned", character: createExtraCharacter(content, t, { id, label, zone, time: state.time, usedNames }, rng) });
    store.append({ type: "name_learned", characterId: state.playerId, targetId: id });
    store.append({ type: "name_learned", characterId: id, targetId: state.playerId });
    return id;
  };
  for (const part of parts) {
    const state = store.getState();
    const me = state.playerId;
    for (const flag of historyFlags(content, part)) store.append({ type: "flag_set", characterId: me, flag });
    store.append({
      type: "belief_added",
      characterId: me,
      belief: { id: `b_${state.nextBeliefNo}`, fact: sentence(describeHistoryPart(content, part)), source: "seen", accuracy: "exact", learnedAt: state.time },
    });
    const person = part.kind === "loss" ? part.by : part.kind === "enemy" ? part.target : null;
    if (person && state.characters[person] && content.npcs[person]) {
      store.append({ type: "name_learned", characterId: me, targetId: person });
      if (part.kind === "enemy" && part.knows_you) {
        store.append({ type: "name_learned", characterId: person, targetId: me });
        store.append({ type: "relation_changed", from: person, to: me, delta: { trust: -2, affection: -1, respect: 0 }, reason: "지난 일 (배경)" });
      }
    }
    if (part.kind === "kin_alive") {
      const id = spawn(part.template, part.label, part.zone);
      if (id) {
        // 연고는 오래 함께 다닌 사이: 그 구역에서 기다리다 주인공이 오면 합류한다 (기획서 7.9)
        store.append({ type: "companion_joined", characterId: id, kind: "kin" });
        store.append({ type: "companion_parted", characterId: id, zone: part.zone, until: null });
        entries.push({ part, characterId: id });
        continue;
      }
    }
    if (part.kind === "seeking") {
      const zones = Object.values(content.locations).filter((l) => !l.isolated && l.id !== state.playerZone && l.kind !== "base");
      const zone = zones.length ? zones[Math.floor(rng() * zones.length)]!.id : null;
      const id = zone ? spawn(part.template, part.label, zone) : null;
      if (id) {
        entries.push({ part, characterId: id });
        continue;
      }
    }
    if (part.kind === "debt") {
      const sizes = content.scenario.custom_start?.debt_sizes ?? { small: 5, large: 15 };
      store.append({ type: "debt_changed", characterId: me, factionId: part.faction, delta: sizes[part.size] });
    }
    entries.push({ part });
  }
  store.append({ type: "background_set", entries });
}
