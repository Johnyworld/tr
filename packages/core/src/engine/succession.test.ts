import { describe, expect, it } from "vitest";
import { runCommand } from "../commands/commands.ts";
import { InMemoryRepository } from "../persistence/repository.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { createTestWorld, TEST_CONTENT } from "../testing.ts";
import { describePlayerState } from "./context.ts";

/** 판정이 늘 1+1 (실패) → 선언한 위험이 그대로 적용된다 */
const ones: Rng = () => 0;

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동",
  check: null,
  activity: null,
  deed: null,
  target: null,
  narration_summary: null,
  for_mission: false,
  ...input,
});

const deadly = {
  move: "fight",
  stat: "strength",
  difficulty: "hard",
  harm_on_failure: "heavy",
  harm_cause: "총상",
};

/** 행적 하나를 남기고 죽는 세계 */
function deadWorld() {
  const world = createTestWorld("mcp", ones, new InMemoryRepository());
  world.executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" });
  world.executeTool(
    "take_action",
    act({
      intent: "분대장을 감싼다",
      deed: { summary: "총격 속에서 분대장을 감쌌다", tags: ["bravery"], severity: 3, privacy: "public", noisy: true, condition: "always" },
    }),
  );
  world.recordSummary("scene", "이전 캐릭터만 아는 장면");
  world.executeTool("take_action", act({ intent: "돌격", check: deadly }));
  world.executeTool("take_action", act({ intent: "돌격", check: deadly }));
  expect(world.isPlayerDead()).toBe(true);
  return world;
}

describe("사망과 연대기", () => {
  it("부상 트랙으로 죽으면 코드가 연대기 기록을 만든다 (원인, 행적, 공적, 기간)", () => {
    const world = deadWorld();
    const [record] = world.state().chronicle;
    expect(record).toMatchObject({ characterId: "player", name: "신병", factionId: "faction_a", rank: "grunt", cause: "총상", epitaph: null });
    expect(record!.deeds).toEqual(["총격 속에서 분대장을 감쌌다"]);
    expect(world.chronicleText()).toContain("1. 신병 · 우리 무리 하급 전투원 · 1일 생존");
  });

  it("묘비명은 죽은 직후 한 번만 쓸 수 있다", () => {
    const alive = createTestWorld();
    expect(alive.executeTool("write_epitaph", { text: "아직" }).ok).toBe(false);
    const world = deadWorld();
    expect(world.executeTool("write_epitaph", { text: "끝까지 분대장 곁에 있었다." }).ok).toBe(true);
    expect(world.executeTool("write_epitaph", { text: "다시" }).ok).toBe(false);
    expect(world.chronicleText()).toContain('"끝까지 분대장 곁에 있었다."');
  });

  it("!연대기는 기록과 다음 캐릭터 후보를 보여 준다. 살아 있는 동안 후보는 없다", async () => {
    expect(await createTestWorld().runCommand("!연대기")).toContain("아직 죽은 캐릭터가 없습니다");
    const out = await deadWorld().runCommand("!연대기");
    expect(out).toContain("다음 캐릭터 후보");
    expect(out).toContain("new  새 캐릭터 (테스트 전투원)");
    expect(out).toContain("npc_leader  강분대");
    // 이전 캐릭터가 모르는 인물(npc_stranger)은 후보가 아니다
    expect(out).not.toContain("npc_stranger");
  });
});

describe("다음 캐릭터", () => {
  it("살아 있는 동안에는 바꿀 수 없고, 후보가 아닌 인물도 안 된다", () => {
    expect(createTestWorld().chooseNextCharacter("new").ok).toBe(false);
    const world = deadWorld();
    expect(world.chooseNextCharacter("npc_stranger").ok).toBe(false);
  });

  it("새 캐릭터: 시작 역할로 만들고, 이전 캐릭터의 기억은 넘어가지 않고 죽음과 큰 행적만 소문으로 듣는다", () => {
    const world = deadWorld();
    const result = world.chooseNextCharacter("new", "두번째");
    expect(result.ok).toBe(true);
    const s = world.state();
    expect(s.playerId).toBe("pc_2");
    expect(s.characters.pc_2).toMatchObject({ name: "두번째", factionId: "faction_a", dead: false, merit: 0 });
    expect(s.runStartedAt).toBe(s.time);
    expect(s.scene.present).toEqual([]);
    expect(s.playerZone).toBe("a_home");
    const beliefs = (s.beliefs.pc_2 ?? []).map((b) => `${b.source}:${b.fact}`);
    expect(beliefs).toContain("report:신병이 죽었다고 한다 (총상).");
    expect(beliefs).toContain("rumor:신병에 대해 이런 말이 돈다: 총격 속에서 분대장을 감쌌다.");
    // 이전 캐릭터의 요약·믿음은 현재 캐릭터의 것이 아니다
    expect(world.summaries()).toEqual([]);
    expect(world.recap()).toBe("");
    const prompt = describePlayerState(s, TEST_CONTENT);
    expect(prompt).not.toContain("이전 캐릭터만 아는 장면");
    expect(prompt).toContain("A는 C와 전쟁 중이다"); // 역할의 시작 지식은 새 캐릭터도 안다 (자기 몫으로)
    expect((s.beliefs.pc_2 ?? []).filter((b) => b.fact === "A는 C와 전쟁 중이다")).toHaveLength(1);
    // 대화 기록에 경계가 남는다
    expect(world.transcript().at(-1)).toMatchObject({ kind: "note", characterSwitch: true });
    // 이제 행동할 수 있다
    expect(world.executeTool("take_action", act({ intent: "주변을 본다" })).ok).toBe(true);
  });

  it("아는 인물로 이어 가면 그 인물이 된다. 그 인물이 직접 본 이전 캐릭터의 행적을 기억한다", () => {
    const world = deadWorld();
    expect(world.chooseNextCharacter("npc_leader").ok).toBe(true);
    const s = world.state();
    expect(s.playerId).toBe("npc_leader");
    expect(s.characters.npc_leader?.dead).toBe(false);
    expect(s.known.npc_leader).not.toContain("npc_leader");
    const facts = (s.beliefs.npc_leader ?? []).map((b) => b.fact);
    expect(facts).toContain("동쪽 초소 교대 시간"); // 그 인물이 원래 알던 것
    expect(facts).toContain("신병: 총격 속에서 분대장을 감쌌다."); // 장면에서 직접 봤다
    const status = runCommand("!상태", { state: s, content: TEST_CONTENT, summaries: [] });
    expect(status).toContain("강분대");
    // 역할의 상관이 자기 자신이 됐으면 상관은 없다
    expect(status).not.toContain("상관 강분대");
  });

  it("두 번째 죽음도 연대기에 이어 쌓인다", () => {
    const world = deadWorld();
    world.chooseNextCharacter("new");
    for (let i = 0; i < 3 && !world.isPlayerDead(); i++) world.executeTool("take_action", act({ intent: "돌격", check: deadly }));
    expect(world.state().chronicle.map((r) => r.characterId)).toEqual(["player", "pc_2"]);
  });
});
