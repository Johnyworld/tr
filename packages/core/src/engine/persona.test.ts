import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { describePlayerState } from "./context.ts";
import { parsePersona, personaOf, rapportImpression, rollBlowup, rollLeak, romanceShift } from "./persona.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 성격 축 (12-99) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const s = content.scenario;
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });

function setup(rng = () => 0.01) {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_a_grunt", "world_persona", () => 0.5)]);
  const ctx = { store, rng, content };
  runAfterTimeAdvance(ctx);
  const me = () => store.getState().characters[store.getState().playerId]!;
  return { store, ctx, me };
}

/** 장면에 NPC 하나를 세운다 */
function withNpc(env: ReturnType<typeof setup>, id: string) {
  const st = env.store.getState();
  st.scene.present = [...st.scene.present, id];
  st.characters[id]!.dead = false;
  return st.characters[id]!;
}

describe("성격 축", () => {
  it("NPC는 성격 트레잇에서 축 값을 얻는다 (무뚝뚝·다혈질·보호 본능 → 과묵 2, 다혈질 2, 다정 1)", () => {
    const { store } = setup();
    const npc = Object.values(store.getState().characters).find((c) => c.traits.includes("hot_tempered") && c.traits.includes("blunt"))!;
    const p = personaOf(content, npc);
    expect(p.temper).toBe(2);
    expect(p.talk).toBe(-2);
  });

  it("트레잇이 정하지 않은 축은 인물 id에서 채운다: 판마다 같고, 트레잇·직접 적은 값이 우선이다", () => {
    const npcs = Object.values(content.npcs).map((n) => ({ id: n.id, traits: n.traits, persona: null }));
    const hearts = npcs.map((n) => personaOf(content, n).heart ?? 0);
    expect(new Set(hearts).size).toBeGreaterThanOrEqual(4); // 금사빠 ↔ 돌부처가 퍼진다
    expect(npcs.map((n) => personaOf(content, n).heart ?? 0)).toEqual(hearts); // 같은 인물은 늘 같다
    const hot = npcs.find((n) => n.traits.includes("hot_tempered"))!;
    expect(personaOf(content, hot).temper).toBe(2); // 트레잇이 정한 축은 채우지 않는다
    expect(personaOf(content, { ...hot, persona: { temper: -1 } })).toEqual({ temper: -1 }); // 직접 적은 값 (주인공)
    // 주인공처럼 비워 둔 값({})은 채우지 않는다
    expect(personaOf(content, { ...hot, persona: {} })).toEqual({});
  });

  it("플레이어의 답을 읽는다: 이름과 단계, 이름만이면 1, 기본은 모두 0", () => {
    expect(parsePersona(s, "다혈질 2, 과묵함 1")).toEqual({ ok: true, values: { temper: 2, talk: -1 } });
    expect(parsePersona(s, "돌부처")).toEqual({ ok: true, values: { heart: 1 } });
    expect(parsePersona(s, "기본")).toEqual({ ok: true, values: {} });
    expect(parsePersona(s, "다혈질 3").ok).toBe(false);
    expect(parsePersona(s, "용감함 1").ok).toBe(false);
    expect(parsePersona(s, "다혈질 1, 온화함 1").ok).toBe(false); // 같은 축 두 번
  });

  it("궁합: 다정함·원칙 축이 같은 쪽이면 첫인상 +, 반대쪽이면 -", () => {
    const { me, store } = setup();
    const npc = Object.values(store.getState().characters).find((c) => c.id !== me().id && personaOf(content, c).warmth! > 0)!;
    me().persona = { warmth: 2 };
    expect(rapportImpression(content, npc, me())).toBe(1);
    me().persona = { warmth: -2 };
    expect(rapportImpression(content, npc, me())).toBe(-1);
    me().persona = {};
    expect(rapportImpression(content, npc, me())).toBe(0);
  });

  it("금사빠 ↔ 돌부처는 NPC의 연애 문턱을 바꾼다", () => {
    const { store } = setup();
    const npc = Object.values(store.getState().characters).find((c) => c.id !== store.getState().playerId)!;
    npc.persona = { heart: 2 };
    expect(romanceShift(content, npc)).toBe(2);
    npc.persona = { heart: -1 };
    expect(romanceShift(content, npc)).toBe(-1);
  });

  it("다혈질이 도발당하면 발끈하고, 상대의 호감이 떨어지고, 🎭 줄이 GM에게 간다", () => {
    const env = setup(() => 0.01);
    env.me().persona = { temper: 2 };
    const npc = withNpc(env, Object.keys(content.npcs)[0]!);
    const before = env.store.getState().relations[npc.id]?.[env.me().id]?.affection ?? 0;
    const out = executeTool("take_action", act({ provoked: true, target: npc.id }), env.ctx);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.resultText).toContain("🎭 다혈질 2: 발끈했다");
    expect(env.store.getState().relations[npc.id]![env.me().id]!.affection).toBe(before - 1);
    // 온화한 사람은 발끈하지 않는다
    const calm = setup(() => 0.01);
    calm.me().persona = { temper: -2 };
    expect(rollBlowup(calm.ctx, null)).toBeNull();
  });

  it("수다스러우면 이야기하다 아는 사실 하나가 새어 나간다 (그 인물이 알게 된다)", () => {
    const env = setup(() => 0.01);
    env.me().persona = { talk: 2 };
    const npc = withNpc(env, Object.keys(content.npcs)[0]!);
    const st = env.store.getState();
    env.ctx.store.append({ type: "belief_added", characterId: env.me().id, belief: { id: `b_${st.nextBeliefNo}`, fact: "동쪽 초소 열쇠는 우물 뒤에 숨겨 두었다", source: "seen", accuracy: "exact", learnedAt: st.time } });
    const theirs = () => (env.store.getState().beliefs[npc.id] ?? []).map((b) => b.fact);
    const line = rollLeak(env.ctx, npc.id);
    expect(line).toContain("🎭 수다스러움 2: 무심코 말해 버렸다");
    expect(theirs().some((f) => env.store.getState().beliefs[env.me().id]!.some((b) => b.fact === f))).toBe(true);
    // 과묵하면 새지 않는다
    env.me().persona = { talk: -1 };
    expect(rollLeak(env.ctx, npc.id)).toBeNull();
  });

  it("GM 상태에 주인공의 성격과 연기 지침, 꼬리표 규칙이 들어간다", () => {
    const { me, store } = setup();
    me().persona = { temper: 2, talk: -1 };
    const text = describePlayerState(store.getState(), content);
    expect(text).toContain("성격: 다혈질 2(같은 지시도 거칠게 하고 도발에 쉽게 발끈한다), 과묵함 1(말을 아낀다)");
    expect(text).toContain("(다혈질)처럼 꼬리표");
  });
});
