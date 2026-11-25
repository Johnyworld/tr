import type { HistoryPart } from "../game/background.ts";
import { describeHistoryPart, historyFlags } from "../game/background.ts";
import { sentence } from "../text.ts";
// 지난 일은 세계가 열리기 전의 일이다: 다음 날 "어제"로 보이지 않게 (12-261, PT16 졸병)
import { START_TIME } from "../rules/time.ts";
import { createExtraCharacter } from "./extras.ts";
import type { ToolContext } from "./toolkit.ts";
import type { RoleContent } from "../content/schemas.ts";
import { groupRules, makeFamily, memberLabel, memberTemplate } from "../game/startGroup.ts";
import { heldOf } from "../rules/held.ts";
import { zoneOf } from "../rules/place.ts";
import { settingOf } from "../game/settings.ts";
import { ownedBy } from "../rules/home.ts";
import { templateKind } from "../game/kinds.ts";
import { startRelation } from "../rules/regard.ts";

/**
 * 배경 부품을 세이브의 역사로 남긴다 (기획서 12.6). 새 세계를 만들 때 한 번.
 * - 플래그: 배경으로 열리는 이야기 (bg_*)
 * - 주인공의 기억: 부품마다 한 문장 (주인공이 아는 대로)
 * - 원수·가해자가 인물이면 주인공은 그 이름을 안다. 원수가 주인공을 알면(knows_you) 그쪽의 신뢰가 낮다
 * - 살아 있는 가족은 그 구역에서 기다리는 연고 동행, 찾는 사람은 코드가 아무 구역에나 둔다 (아무도 모른다)
 * - 빚은 월드가 정한 크기로
 */
export function applyBackground(ctx: ToolContext, parts: readonly HistoryPart[]): void {
  if (parts.length === 0) return;
  ctx.store.append({ type: "background_set", entries: applyHistoryParts(ctx, parts) });
}

/** 배경 부품을 세계에 남긴다 (플래그·기억·사람·빚). 세이브의 배경 목록은 부르는 쪽이 정한다 */
function applyHistoryParts(ctx: ToolContext, parts: readonly HistoryPart[]): { part: HistoryPart; characterId?: string }[] {
  const { store, content, rng } = ctx;
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
    // 다른 구역에 있는 사람이라 지금 장면에는 없다
    if (zone !== state.playerZone && store.getState().scene.present.includes(id)) store.append({ type: "npc_left", npcId: id });
    return id;
  };
  for (const part of parts) {
    const state = store.getState();
    const me = state.playerId;
    for (const flag of historyFlags(content, part)) store.append({ type: "flag_set", characterId: me, flag });
    store.append({
      type: "belief_added",
      characterId: me,
      belief: { id: `b_${state.nextBeliefNo}`, fact: sentence(describeHistoryPart(content, part, true)), source: "seen", accuracy: "exact", learnedAt: Math.min(state.time, START_TIME - 1) },
    });
    const person = part.kind === "loss" ? part.by : part.kind === "enemy" ? part.target : null;
    // 같은 사람이 부품 여럿에 나올 수 있다 (가족을 죽인 자이자 원수): 이미 아는 이름은 다시 배우지 않는다
    const knows = (who: string, whom: string) => (store.getState().known[who] ?? []).includes(whom);
    if (person && state.characters[person] && content.npcs[person]) {
      // 얼굴만 아는 원수 (name_known: false): 이름은 플레이 중에 알게 된다
      const nameKnown = part.kind === "loss" || part.kind === "enemy" ? part.name_known !== false : true;
      if (!nameKnown) {
        if (!(store.getState().met[me] ?? []).includes(person)) store.append({ type: "face_known", characterId: me, targetId: person });
      } else if (!knows(me, person)) store.append({ type: "name_learned", characterId: me, targetId: person });
      if (part.kind === "enemy" && part.knows_you) {
        if (!knows(person, me)) store.append({ type: "name_learned", characterId: person, targetId: me });
        startRelation(ctx, { from: person, to: me, delta: { trust: -4, affection: -2, respect: 0 }, reason: "지난 일 (배경)" });
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
  return entries;
}

/**
 * 설정의 뒷받침 (4.6.4, 12-246): 지금 세계에 무언가가 있다고 말하는 비밀은 엔진 상태로 진짜로 만든다 (원칙 2).
 * - 지난 일 부품으로: 탈영(다른 무리), 큰 빚(다른 무리), 적 무리의 가족(적대하는 무리의 거점에 사는 연고)
 * - 그 밖: 트레잇, 우리 거점 사물함의 물건, 소중한 것(시작 소지품)
 * 새 게임에서는 부품을 배경 목록에 함께 넣고(partsOnly), 계승한 새 캐릭터는 여기서 바로 남긴다
 */
export function settingBackingParts(ctx: ToolContext): HistoryPart[] {
  const { content, rng } = ctx;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me) return [];
  const mine = me.factionId || null;
  const parts: HistoryPart[] = [];
  const pick = <T>(xs: readonly T[]): T | null => (xs.length ? xs[Math.floor(rng() * xs.length)]! : null);
  const others = Object.keys(content.factions).filter((f) => f !== mine && Object.keys(state.zones).some((z) => ownedBy(state, z, f)));
  for (const id of me.settings) {
    const b = settingOf(content.scenario, id)?.backing;
    if (!b) continue;
    if (b.deserter) {
      const f = pick(others);
      if (f) parts.push({ kind: "deserter", faction: f });
    }
    if (b.debt) {
      const f = pick(others);
      if (f) parts.push({ kind: "debt", faction: f, size: b.debt });
    }
    if (b.kin_enemy) {
      // 가족이 있을 수 있는 무리만 (걸어서 닿는 거점이 있는 무리): 섬 무리를 고르면 가족 없이 빠졌다
      const reachable = others.filter((f) => Object.values(content.locations).some((l) => !l.isolated && l.kind === "base" && ownedBy(state, l.id, f)));
      const hostile = reachable.filter((f) => (mine ? (state.factions[f]?.disposition?.[mine] ?? 0) < 0 : !!content.scenario.helpless?.prey_on_strangers.includes(f)));
      const f = pick(hostile.length ? hostile : reachable);
      const base = f ? pick(Object.values(content.locations).filter((l) => !l.isolated && ownedBy(state, l.id, f) && l.kind === "base").map((l) => l.id)) : null;
      const template = pick((content.scenario.custom_start?.kin ?? []).filter((t) => content.extras[t] && templateKind(content.extras[t]) === "person"));
      if (base && template) parts.push({ kind: "kin_alive", template, label: content.extras[template]!.label, zone: base });
    }
  }
  return parts;
}

/** 부품이 아닌 뒷받침 (사물함·소중한 것), 계승한 새 캐릭터면 부품도. 트레잇은 캐릭터를 만들 때 붙는다 (createCharacterFromRole) */
export function applySettingBacking(ctx: ToolContext, options: { parts?: boolean } = {}): void {
  const { store, content } = ctx;
  if (options.parts) applyHistoryParts(ctx, settingBackingParts(ctx));
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me) return;
  for (const id of me.settings) {
    const b = settingOf(content.scenario, id)?.backing;
    if (!b) continue;
    if (b.keepsake && content.items[b.keepsake]) store.append({ type: "item_granted", to: me.id, itemId: b.keepsake, quantity: 1 });
    if (b.stash && content.items[b.stash.item]) {
      const home = Object.values(content.locations).find((l) => l.kind === "base" && ownedBy(state, l.id, me.factionId))?.id;
      if (home) {
        store.append({ type: "item_granted", to: me.id, itemId: b.stash.item, quantity: b.stash.quantity });
        store.append({ type: "item_stashed", characterId: me.id, zone: home, itemId: b.stash.item, quantity: b.stash.quantity, direction: "put" });
      }
    }
  }
}

/**
 * 찾는 가족 (역할의 family, 튜토리얼, 기획서 12.4.1). 세계를 만들 때 한 번.
 * 코드가 주인공 나이에 맞춰 가족 몇 사람을 만들어 그 구역에 둔다. 그 구역 무리의 사람이 되고, 그 무리 사람들은 이름을 안다.
 * 주인공은 가족의 이름을 알지만 어디 있는지는 모른다 (믿음에는 "어디 있는지 모른다"만). 만나면 클리어 목표(reunite)가 찬다
 */
/**
 * 시작 장면의 분대 (12-241, 플레이 테스트 13: 시작 장면 글에는 분대원 넷이 앉아 있는데 장면에는 아무도 없어 npc_presence를 네 번 불렀다):
 * 분대가 있는 역할이면 같은 구역의 분대원을 장면에 둔다
 */
export function seatStartSquad(ctx: ToolContext, role: RoleContent | undefined): void {
  const state = ctx.store.getState();
  for (const id of role?.squad ?? []) {
    const c = state.characters[id];
    const home = zoneOf(state, ctx.content, id);
    if (!c || c.dead || heldOf(c) || home !== state.playerZone || ctx.store.getState().scene.present.includes(id)) continue;
    ctx.store.append({ type: "npc_entered", npcId: id });
  }
}

export function addStartFamily(ctx: ToolContext, role: RoleContent | undefined): void {
  const { store, content, rng } = ctx;
  const family = role?.family;
  if (!family || !groupRules(content)) return;
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me) return;
  const [lo, hi] = family.count;
  const count = lo + Math.floor(rng() * (hi - lo + 1));
  const surnames = content.scenario.names?.surnames ?? [];
  const surname = surnames.find((s) => me.name.startsWith(s)) ?? null;
  const usedNames = new Set(Object.values(state.characters).map((c) => c.name));
  const genders = content.scenario.creation?.genders.map((g) => g.id) ?? [];
  const members = makeFamily(content, { age: me.age ?? role!.age, gender: me.gender ?? genders[0] ?? "" }, count, rng, surname, usedNames);
  const owner = content.locations[family.zone]?.owner ?? null;
  const ids: string[] = [];
  const labels: string[] = [];
  const usedLooks = new Set<string>();
  for (const m of members) {
    const t = content.extras[memberTemplate(content, m)];
    if (!t) continue;
    const s = store.getState();
    const id = `ex_${s.nextExtraNo}`;
    const label = memberLabel(content, { me: { age: me.age ?? role!.age, gender: me.gender ?? "" } }, m);
    const made = createExtraCharacter(content, t, { id, label, zone: family.zone, time: s.time, usedNames, name: m.name, age: m.age, gender: m.gender, usedLooks }, rng);
    const character = family.place && made.extra ? { ...made, extra: { ...made.extra, place: family.place } } : made;
    if (character.extra?.look) usedLooks.add(character.extra.look);
    // 그 구역 무리에 받아들여져 산다 (그 무리 사람들이 안다)
    const settled = groupRules(content)?.settled_rank;
    store.append({ type: "extra_spawned", character: owner && content.factions[owner] ? { ...character, factionId: owner, ...(settled ? { rank: settled } : {}) } : character });
    if (family.zone !== s.playerZone && store.getState().scene.present.includes(id)) store.append({ type: "npc_left", npcId: id });
    // 가족은 서로 이름을 알고, 서로 아낀다 (거의 가장 깊은 사이)
    store.append({ type: "name_learned", characterId: s.playerId, targetId: id });
    store.append({ type: "name_learned", characterId: id, targetId: s.playerId });
    startRelation(ctx, { from: id, to: s.playerId, delta: family.bond, reason: "가족", known: true });
    startRelation(ctx, { from: s.playerId, to: id, delta: family.bond, reason: "가족" });
    for (const other of ids) {
      store.append({ type: "name_learned", characterId: id, targetId: other });
      store.append({ type: "name_learned", characterId: other, targetId: id });
    }
    ids.push(id);
    labels.push(`${label} ${m.name}`);
  }
  if (!ids.length) return;
  // 그 무리 사람들은 가족의 이름을 안다 (물어보면 그 무리 사람만 답할 수 있다)
  if (owner) {
    for (const npc of Object.values(content.npcs)) {
      if (npc.faction !== owner || !store.getState().characters[npc.id]) continue;
      for (const id of ids) store.append({ type: "name_learned", characterId: npc.id, targetId: id });
    }
  }
  store.append({ type: "family_set", ids });
  store.append({ type: "flag_set", characterId: state.playerId, flag: "bg_family_lost" });
  const s = store.getState();
  store.append({
    type: "belief_added",
    characterId: s.playerId,
    belief: { id: `b_${s.nextBeliefNo}`, fact: `가족(${labels.join(", ")})${LOST_FAMILY_FACT}`, source: "seen", accuracy: "exact", learnedAt: Math.min(s.time, START_TIME - 1) },
  });
}

/** 헤어진 가족의 믿음 꼬리 (다시 만나면 지운다, engine/scenarioProgress.ts) */
export const LOST_FAMILY_FACT = "과 헤어졌다. 살아 있다고 믿지만 어디 있는지 모른다.";

/** 시작할 때 가까운 사람들 (역할의 start_bonds): 그 사람들이 주인공을 보는 관계를 범위 안에서 무작위로 올린다 */
export function applyStartBonds(ctx: ToolContext, role: RoleContent | undefined): void {
  const { store, rng } = ctx;
  const b = role?.start_bonds;
  if (!b) return;
  const roll = ([lo, hi]: [number, number]) => lo + Math.floor(rng() * (hi - lo + 1));
  const me = store.getState().playerId;
  for (const id of b.ids) {
    if (!store.getState().characters[id]) continue;
    const extra = id === b.best ? 2 : 0;
    startRelation(ctx, {
      from: id,
      to: me,
      delta: { trust: roll(b.trust) + extra, affection: roll(b.affection) + extra, respect: roll(b.respect) + extra },
      reason: "오래 함께 버텨 온 사이",
      known: true,
    });
  }
}
