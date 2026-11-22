import { describe, expect, it } from "vitest";
import { createWorldEvent, type GameState } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { runCommand } from "../commands/commands.ts";
import { describePlayerState } from "./context.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { rollHear, rollLeak } from "./persona.ts";
import { promoteExtra, describeProfileLines } from "./people.ts";
import { createExtraCharacter } from "./extras.ts";
import { personaOf } from "./persona.ts";
import { checkPromotion, PROMOTION, recentSetback } from "../game/missions.ts";
import { knowsName } from "../game/acquaintance.ts";
import { personProfile } from "../views/person.ts";
import { effectiveSkill } from "./traits.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";

/** 플레이 테스트 14: 표시·글·정보 누설 묶음 */
const content = loadRealContent();
const s = content.scenario;

function setup(role: string, rng: () => number = () => 0.5) {
  const store = new InMemoryGameStore([createWorldEvent(content, role, `world_pt14_${role}`, () => 0.5)]);
  const ctx = { store, rng, content };
  runAfterTimeAdvance(ctx);
  const me = () => store.getState().characters[store.getState().playerId]!;
  return { store, ctx, me, state: () => store.getState() };
}

/** 장면에 인물 하나를 세운다 */
function withNpc(state: GameState, id: string) {
  state.scene.present = [...state.scene.present, id];
  state.characters[id]!.dead = false;
  return state.characters[id]!;
}

const status = (state: GameState) => runCommand("?상태", { state, content, summaries: [], prefix: "?" });

describe("1. ?상태와 GM 상태의 스킬 값은 같다 (공통 규칙 12)", () => {
  it("트레잇 보정이 ?상태에도 들어간다: 강심장 버티기, 서툰 거짓말", () => {
    const env = setup("role_t_visitor");
    const me = env.me();
    me.traits = [...new Set([...me.traits, "eagle_eye"])];
    const sense = effectiveSkill(content, me, "sense_danger");
    const label = s.moves.find((m) => m.id === "sense_danger")!.label;
    const out = status(env.state());
    expect(out).toContain(`${label} ${sense >= 0 ? "+" : ""}${sense} (트레잇 +1)`);
    // GM 상태도 같은 값
    expect(describePlayerState(env.state(), content)).toContain(`${label}(sense_danger·`);
    expect(describePlayerState(env.state(), content)).toMatch(new RegExp(`${label}\\(sense_danger·[^)]*\\) ${sense >= 0 ? "\\+" : ""}${sense}`));
  });

  it("진급 조건의 복무 날짜는 시계와 같은 셈이다 (1일째 → '복무 1일째')", () => {
    const base = { rank: s.promotion.from, merit: 99, disobedience: 0 } as Parameters<typeof checkPromotion>[0];
    const out = checkPromotion(base, s.promotion, 330, 330, 6).missing;
    expect(out).toEqual([`복무 1일째 (${PROMOTION.minDaysServed}일을 다 채운 ${PROMOTION.minDaysServed + 1}일째부터)`]);
  });

  it("상관이 다음 날 알게 된 행적은 그 행적이 있던 날도 함께 보인다", () => {
    const env = setup("role_e_porter");
    const st = env.state();
    const boss = Object.keys(content.npcs).find((id) => st.characters[id]?.factionId === env.me().factionId)!;
    env.store.append({ type: "deed_recorded", deed: { id: "d_1", actorId: st.playerId, summary: "접골사에게 거짓말했다", tags: ["deceit"], severity: 2, at: st.time, witnesses: [], searched: false } });
    env.store.append({ type: "time_advanced", activity: "rest", from: st.time, to: st.time + MINUTES_PER_DAY });
    env.store.append({ type: "deed_learned", deedId: "d_1", npcId: boss, source: "rumor", delta: { trust: -1, affection: 0, respect: 0 } });
    expect(recentSetback(env.state(), st.playerId, boss)).toContain("(1일차의 일 — 접골사에게 거짓말했다)");
  });
});

describe("2. 같은 무리 동료는 처음부터 서로 이름을 안다", () => {
  it("신병: 역할의 known_npcs에 없는 같은 무리 사람(의무실 보조, 다른 분대 대원)도 이름을 안다", () => {
    const env = setup("role_a_grunt");
    const st = env.state();
    for (const id of ["a_yejin", "pa_narae"]) {
      expect(st.characters[id]!.factionId).toBe(env.me().factionId);
      expect(knowsName(st, st.playerId, id)).toBe(true);
      expect(knowsName(st, id, st.playerId)).toBe(true);
    }
    // 다른 무리 사람은 여전히 모른다
    const stranger = Object.keys(content.npcs).find((id) => st.characters[id]!.factionId && st.characters[id]!.factionId !== env.me().factionId && !content.roles.role_a_grunt!.known_npcs.includes(id))!;
    expect(knowsName(st, st.playerId, stranger)).toBe(false);
  });
});

describe("3. 자란 인물은 원래 성격·말씨를 이어받는다", () => {
  it("수다스러운 사람에게는 말을 아끼는 말투를 고르지 않는다", () => {
    const template = Object.values(content.extras).find((t) => t.profile?.voices.some((v) => (v.persona?.talk ?? 0) < 0) && t.profile.voices.some((v) => !v.persona?.talk || v.persona.talk > 0))!;
    for (let i = 0; i < 20; i++) {
      const env = setup("role_a_grunt", () => (i + 0.5) / 20);
      const st = env.state();
      const id = `ex_${st.nextExtraNo}`;
      const c = createExtraCharacter(content, template, { id, label: template.label, zone: st.playerZone, time: st.time, usedNames: new Set() }, () => 0.3);
      c.traits = ["talkative"];
      env.store.append({ type: "extra_spawned", character: c, unseen: true });
      expect(personaOf(content, env.state().characters[id]!).talk).toBe(2);
      expect(promoteExtra(env.ctx, id)).toBe(true);
      const style = env.state().characters[id]!.profile!.voice.style;
      const voice = template.profile!.voices.find((v) => v.style === style)!;
      expect(voice.persona?.talk ?? 0).toBeGreaterThanOrEqual(0);
    }
  });

  it("사투리를 쓰는 사람이면 카드의 말투 줄에 말씨를 얹으라고 적는다", () => {
    const env = setup("role_a_grunt");
    const st = env.state();
    const template = Object.values(content.extras).find((t) => t.profile && t.faction === "faction_a")!;
    const id = `ex_${st.nextExtraNo}`;
    const c = createExtraCharacter(content, template, { id, label: template.label, zone: st.playerZone, time: st.time, usedNames: new Set() }, () => 0.3);
    c.origin = { id: s.origins.find((o) => o.dialect)!.id, dialect: true };
    env.store.append({ type: "extra_spawned", character: c, unseen: true });
    promoteExtra(env.ctx, id);
    const lines = describeProfileLines(env.state(), content, env.state().characters[id]!);
    expect(lines[0]).toContain("말씨 줄의 사투리를 그대로 얹는다");
  });

  it("사투리 말투는 표준어를 쓰는 사람에게 고르지 않는다", () => {
    const template = Object.values(content.extras).find((t) => t.profile?.voices.some((v) => v.dialect))!;
    const env = setup("role_a_grunt", () => 0);
    const st = env.state();
    const id = `ex_${st.nextExtraNo}`;
    const c = createExtraCharacter(content, template, { id, label: template.label, zone: st.playerZone, time: st.time, usedNames: new Set() }, () => 0.3);
    c.origin = { id: s.origins[0]!.id, dialect: false };
    env.store.append({ type: "extra_spawned", character: c, unseen: true });
    promoteExtra(env.ctx, id);
    const style = env.state().characters[id]!.profile!.voice.style;
    // 사투리 아닌 말투가 있으면 그것을 고른다 (모두 사투리면 어쩔 수 없다)
    if (template.profile!.voices.some((v) => !v.dialect)) expect(template.profile!.voices.find((v) => v.style === style)!.dialect ?? false).toBe(false);
  });
});

describe("4. 결과 문구의 조사", () => {
  it("harm_cause는 엔진이 고치지 않고 그대로 옮긴다 (\"…내리친다\")", () => {
    const env = setup("role_l_wanderer", () => 0.01);
    const cause = "약탈자의 쇠지렛대가 머리나 어깨를 내리친다";
    const r = executeTool(
      "take_action",
      { intent: "막는다", check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "light", harm_cause: cause, harm_kind: "blunt", infected_source: false, target_harm: "none", distance: "close" }, activity: null, deed: null, target: null, narration_summary: null, for_mission: false },
      env.ctx,
    );
    expect(r.ok).toBe(true);
    const text = (r as { resultText: string }).resultText;
    expect(text).toContain("내리친다");
    expect(text).not.toContain("내리챜");
  });
});

describe("5. 잠 시간 문구의 숫자", () => {
  it("피곤하지 않은 잠: 이번에 잔 시간과, 이어진 잠이면 합친 시간을 적는다", () => {
    const env = setup("role_b_guard");
    const st = env.state();
    // 낮잠 8시간을 자고 막 깼다고 둔다
    st.lastSleptFrom = st.time - 8 * 60;
    st.lastWokeAt = st.time - 5;
    const r = executeTool("take_action", { intent: "잔다", check: null, activity: { kind: "sleep", until: "night" }, deed: null, target: null, narration_summary: null, for_mission: false }, env.ctx);
    expect(r.ok).toBe(true);
    const text = (r as { resultText: string }).resultText;
    const hours = s.body!.fatigue!.rested_sleep_hours!;
    expect(text).toContain("피곤하지 않아");
    expect(text).not.toContain(`피곤하지 않아 ${hours}시간 자고`);
    expect(text).toContain("조금 전에 깬 잠과 이어져");
  });
});

describe("6. ?인물: 막 만난 사람의 소개와 만남 기억", () => {
  it("이름을 막 들은 다른 무리 사람의 평판은 보이지 않고, 만남·이름 기억은 사실 목록에 남지 않는다", () => {
    const env = setup("role_d_medic");
    const st = env.state();
    const id = Object.keys(content.npcs).find((n) => st.characters[n]!.factionId && st.characters[n]!.factionId !== env.me().factionId && !knowsName(st, st.playerId, n) && content.npcs[n]!.reputation)!;
    withNpc(st, id);
    executeTool("npc_presence", { npc_id: id, action: "enter" }, env.ctx);
    executeTool("learn_name", { target: id, who: "player" }, env.ctx);
    const p = personProfile(env.state(), content, id);
    expect(knowsName(env.state(), env.state().playerId, id)).toBe(true);
    expect(p.reputation).toBeNull();
    expect(p.facts.map((f) => f.fact).join("\n")).not.toMatch(/이름은 모른다|의 이름은/);
    // 같은 무리 사람은 원래 알던 사이라 평판을 안다
    const mate = Object.keys(content.npcs).find((n) => st.characters[n]!.factionId === env.me().factionId && content.npcs[n]!.reputation)!;
    expect(personProfile(env.state(), content, mate).reputation).toBe(content.npcs[mate]!.reputation);
  });
});

describe("7. 수다로 옮기는 말 (공통 규칙 14)", () => {
  it("얻어들음: 주인공 자신에 대한 말(주인공의 이름)은 얻어듣지 않는다", () => {
    const env = setup("role_c_comrades", () => 0.01);
    env.me().persona = { talk: 2 };
    const st = env.state();
    const npc = withNpc(st, Object.keys(content.npcs).find((n) => st.characters[n]!.factionId !== env.me().factionId)!);
    // 그 인물이 아는 것은 주인공의 이름뿐이게
    st.beliefs[npc.id] = [{ id: "b_x1", fact: `붉은연합 약탈조원의 이름은 ${env.me().name}`, source: "report", accuracy: "exact", learnedAt: st.time }];
    expect(rollHear(env.ctx, npc.id)).toBeNull();
    expect((env.state().beliefs[st.playerId] ?? []).some((b) => b.fact.includes(`의 이름은 ${env.me().name}`))).toBe(false);
  });

  it("새어 나감: 만남 기억(\"…와 마주쳤다. 겉모습: …\")과 지난 삶은 옮기지 않고, 옮길 만한 사실만 옮긴다", () => {
    const env = setup("role_c_comrades", () => 0.01);
    env.me().persona = { talk: 2 };
    const st = env.state();
    const npc = withNpc(st, Object.keys(content.npcs)[0]!);
    st.beliefs[st.playerId] = [
      { id: "b_y1", fact: "계단을 기어오르는 감염체와 마주쳤다. 겉모습: 다리가 꺾였다", source: "seen", accuracy: "exact", learnedAt: st.time },
      { id: "b_y2", fact: "붕괴 전에 나는 영업사원이었다.", source: "seen", accuracy: "exact", learnedAt: st.time - 10_000 },
    ];
    st.beliefs[npc.id] = [];
    expect(rollLeak(env.ctx, npc.id)).toBeNull();
    st.beliefs[st.playerId]!.push({ id: "b_y3", fact: "동쪽 초소 열쇠는 우물 뒤에 있다", source: "seen", accuracy: "exact", learnedAt: st.time });
    expect(rollLeak(env.ctx, npc.id)).toContain("동쪽 초소 열쇠는 우물 뒤에 있다");
  });
});

describe("8. 속이기가 먹히면 속은 사람은 행적을 알지 못한다", () => {
  const deceive = s.moves.find((m) => m.id === s.move_roles.deceive)!;
  const lie = (rng: () => number) => {
    const env = setup("role_e_porter", rng);
    const st = env.state();
    const target = Object.keys(content.npcs).find((n) => st.characters[n]!.factionId === env.me().factionId && n !== st.playerId)!;
    withNpc(st, target);
    const r = executeTool(
      "take_action",
      {
        intent: "접골사에게 들개에게 물렸다고 둘러댄다",
        check: { move: deceive.id, stat: deceive.stats[0], difficulty: "normal", harm_on_failure: "none", harm_cause: "", target_harm: "none", distance: "close" },
        activity: null,
        deed: { summary: "감염체에게 물리고도 들개에게 물렸다고 거짓말했다", tags: ["deceit"], severity: 2, privacy: "semi_private", noisy: false, condition: "always" },
        target,
        narration_summary: null,
        for_mission: false,
      },
      env.ctx,
    );
    expect(r.ok).toBe(true);
    return { env, target, text: (r as { resultText: string }).resultText };
  };

  it("성공: 속은 상대는 목격자가 아니고 관계도 떨어지지 않는다", () => {
    const { env, target, text } = lie(() => 0.99);
    const deed = Object.values(env.state().deeds).at(-1)!;
    expect(deed.witnesses.map((w) => w.npcId)).not.toContain(target);
    expect(env.state().deedKnowledge[target]?.[deed.id]).toBeUndefined();
    expect(text).toContain("속아 넘어가");
    expect(env.state().trustDroppedAt?.[target]).toBeUndefined();
  });

  it("실패: 들킨 것이라 상대가 본다", () => {
    const { env, target } = lie(() => 0.01);
    const deed = Object.values(env.state().deeds).at(-1)!;
    expect(deed.witnesses.map((w) => w.npcId)).toContain(target);
  });
});
