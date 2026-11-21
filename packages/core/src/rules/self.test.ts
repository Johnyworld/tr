import { describe, expect, it } from "vitest";
import { createCharacterFromRole, createWorldEvent, type CharacterChoice } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { executeTool } from "../engine/tools.ts";
import { runAfterTimeAdvance } from "../engine/turnStart.ts";
import { applySettingBacking, settingBackingParts } from "../engine/background.ts";
import { loadRealContent } from "../testing.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldManager } from "../world/manager.ts";
import { createSeededRng } from "../rng.ts";
import { againstSetting, knowsPlayerSecretLine, secretKnownBy, settingLines, tellPlayerSecret } from "./self.ts";

/** 공통 규칙 16: 자기다움 (설정 거스르기, 주인공의 비밀, 뒷받침) */
const content = loadRealContent();
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });

function setup(settings: string[], roll = 0.99) {
  let r = roll;
  const store = new InMemoryGameStore([createWorldEvent(content, "role_a_grunt", "world_self", () => 0.5)]);
  const ctx = { store, rng: () => r, content };
  runAfterTimeAdvance(ctx);
  const st = store.getState();
  st.characters[st.playerId]!.settings = settings;
  return { store, ctx, setRoll: (x: number) => (r = x) };
}

describe("설정 거스르기", () => {
  it("주인공의 설정이 아니거나 굴리지 않는 칸이면 오류", () => {
    const { ctx } = setup(["habit_count_bullets"].filter((id) => content.scenario.settings!.items.some((x) => x.id === id)));
    expect(againstSetting(ctx, "ideal_obedience").ok).toBe(false);
    const habit = content.scenario.settings!.items.find((x) => x.slot === "habit")!;
    ctx.store.getState().characters[ctx.store.getState().playerId]!.settings = [habit.id];
    const r = againstSetting(ctx, habit.id);
    expect(r.ok).toBe(false);
  });

  it("이겨 내면 뜻대로, 같은 장면에서는 다시 굴리지 않는다", () => {
    const { ctx, store, setRoll } = setup(["ideal_obedience"], 0.99);
    const r = againstSetting(ctx, "ideal_obedience");
    expect(r.ok && r.proceed).toBe(true);
    expect(r.ok && r.displays.length).toBe(1);
    setRoll(0.01);
    const again = againstSetting(ctx, "ideal_obedience");
    expect(again.ok && again.proceed).toBe(true);
    expect(again.ok && again.displays.length).toBe(0);
    expect(store.events().filter((e) => e.type === "setting_rolled")).toHaveLength(1);
  });

  it("꺾이면 하지 못하고, 같은 장면에서는 다시 굴리지 않는다", () => {
    const { ctx, setRoll } = setup(["ideal_obedience"], 0.01);
    const r = againstSetting(ctx, "ideal_obedience");
    expect(r.ok && r.proceed).toBe(false);
    setRoll(0.99);
    const again = againstSetting(ctx, "ideal_obedience");
    expect(again.ok && again.proceed).toBe(false);
    expect(again.ok && again.displays.length).toBe(0);
  });

  it("take_action.against_setting: 꺾이면 행동이 일어나지 않는다", () => {
    const { ctx } = setup(["ideal_obedience"], 0.01);
    const before = ctx.store.getState().time;
    const out = executeTool("take_action", act({ intent: "명령을 어기고 돌아선다", against_setting: "ideal_obedience" }), ctx);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.resultText).toContain("하지 못한다");
    expect(ctx.store.getState().time).toBeGreaterThan(before);
  });
});

describe("주인공의 비밀", () => {
  it("GM 카드: 주인공에게는 사실과 아는 사람, 남의 카드에는 사실이 실리지 않는다", () => {
    const { ctx } = setup(["secret_killed_friend", "ideal_obedience"]);
    const st = ctx.store.getState();
    const mine = settingLines(content, st, st.characters[st.playerId]!, { player: true }).join("\n");
    expect(mine).toContain("아는 사람: 없음");
    expect(mine).toContain("[ideal_obedience]");
    const fact = content.scenario.settings!.items.find((x) => x.id === "secret_killed_friend")!.fact!;
    expect(mine).toContain(fact);
    const asNpc = settingLines(content, st, { id: "x", settings: ["secret_killed_friend"] }).join("\n");
    expect(asNpc).not.toContain(fact);
  });

  it("털어놓으면 그 자리에 있던 사람이 알고, 그 사람의 카드에만 실린다", () => {
    const { ctx } = setup(["secret_killed_friend"]);
    const st = ctx.store.getState();
    const [a, b] = Object.values(st.characters).filter((c) => c.id !== st.playerId && !c.dead && content.npcs[c.id]).map((c) => c.id);
    st.scene.present = [st.playerId, a!];
    const told = tellPlayerSecret(ctx, a!);
    expect(told.ok).toBe(true);
    const now = ctx.store.getState();
    expect(secretKnownBy(now, now.playerId)).toEqual([a]);
    expect(knowsPlayerSecretLine(content, now, a!)).toContain("비밀을 안다");
    expect(knowsPlayerSecretLine(content, now, b!)).toBeNull();
    expect(tellPlayerSecret(ctx, a!).ok).toBe(false); // 이미 안다
  });

  it("reveal_secret own: 비밀이 없으면 오류", () => {
    const { ctx } = setup([]);
    const st = ctx.store.getState();
    const a = Object.values(st.characters).find((c) => c.id !== st.playerId && !c.dead && content.npcs[c.id])!.id;
    st.scene.present = [st.playerId, a];
    expect(executeTool("reveal_secret", { npc_id: a, own: true }, ctx).ok).toBe(false);
  });
});

describe("뒷받침", () => {
  it("탈영·빚·적 무리의 가족은 다른 무리를 고른 지난 일 부품이 된다", () => {
    const { ctx } = setup(["secret_deserter", "secret_debt_owed"]);
    const st = ctx.store.getState();
    const mine = st.characters[st.playerId]!.factionId;
    const parts = settingBackingParts(ctx);
    expect(parts.map((p) => p.kind).sort()).toEqual(["debt", "deserter"]);
    for (const p of parts) if (p.kind === "debt" || p.kind === "deserter") expect(p.faction).not.toBe(mine);
  });

  it("소중한 것은 소지품, 빼돌린 식량은 우리 거점 사물함에", () => {
    const { ctx } = setup(["secret_stolen_stash", content.scenario.settings!.items.find((x) => x.slot === "keepsake")!.id]);
    applySettingBacking(ctx);
    const st = ctx.store.getState();
    const me = st.characters[st.playerId]!;
    const keep = content.scenario.settings!.items.find((x) => me.settings.includes(x.id) && x.slot === "keepsake")!.backing!.keepsake!;
    expect(me.inventory[keep]).toBe(1);
    const boxes = Object.values(st.stashes[me.id] ?? {});
    expect(boxes.some((b) => (b.canned_food ?? 0) >= 3)).toBe(true);
  });

  it("약에 기대는 비밀은 트레잇을 함께 준다", () => {
    const made = createCharacterFromRole(content.scenario, content.roles.role_a_grunt!, "player", () => 0.5, { name: "", settings: ["secret_addiction"] } as unknown as CharacterChoice);
    expect(made.traits).toContain("pill_habit");
    expect(made.settings).toEqual(["secret_addiction"]);
  });
});

describe("뒷받침: 새 게임 흐름 그대로 (PT14: 땅 주인이 정해지기 전에 돌아 모두 빠졌다)", () => {
  it("탈영·큰 빚·적 무리의 가족·사물함이 세계에 진짜 있다", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-backing-")), content, rngFactory: () => createSeededRng(7) });
    const make = (role: string, settings: string[]) =>
      m.create("mcp", role, { name: "한별", gender: "female", abilities: null, portrait: null, traits: [], settings } as never);
    const a = make("role_b_guard", ["secret_deserter"]);
    const s = a.state();
    expect(s.background.some((e) => e.part.kind === "deserter" && e.part.faction !== s.characters[s.playerId]!.factionId)).toBe(true);
    a.close();
    const b = make("role_b_guard", ["secret_debt_owed"]);
    expect(b.state().background.some((e) => e.part.kind === "debt" && e.part.size === "large")).toBe(true);
    b.close();
    const c = make("role_a_squad_leader", ["secret_family_enemy"]);
    const kin = c.state().background.find((e) => e.part.kind === "kin_alive");
    expect(kin?.characterId && c.state().characters[kin.characterId]).toBeTruthy();
    c.close();
    const d = make("role_e_porter", ["secret_stolen_stash"]);
    const me = d.state().playerId;
    expect(Object.values(d.state().stashes[me] ?? {}).some((box) => (box.canned_food ?? 0) >= 3)).toBe(true);
    d.close();
  }, 60000);
});
