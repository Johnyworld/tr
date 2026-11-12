import { describe, expect, it } from "vitest";
import { createTestWorld, TEST_CONTENT } from "../testing.ts";
import { COMMANDS, runCommand } from "./commands.ts";
import { gauge } from "./format.ts";

describe("게이지", () => {
  it("비율로 환산해 반올림하고, 0이 아니면 최소 1칸, 대괄호 없음", async () => {
    expect(gauge(3, 8)).toBe("███░░░░░");
    expect(gauge(0, 8)).toBe("░░░░░░░░");
    expect(gauge(1, 100)).toBe("█░░░░░░░");
    expect(gauge(4, 4)).toBe("████████");
    expect(gauge(1, 4, 4)).toBe("█░░░");
  });
});

describe("정보 명령어", () => {
  function world() {
    const w = createTestWorld("mcp");
    w.executeTool("take_action", {
      intent: "통조림을 훔친다",
      check: null,
      activity: { kind: "talk", until: null },
      deed: { summary: "통조림을 훔쳤다", tags: ["theft"], severity: 2, privacy: "public", noisy: false, condition: "always" },
      target: null,
      narration_summary: "막사에서 일어났다.",
      for_mission: false,
    });
    return w;
  }

  it("모든 명령어는 읽기 전용이다: 상태·시간·기록이 바뀌지 않는다", async () => {
    const w = world();
    const before = JSON.stringify({ state: w.state(), transcript: w.transcript(), summaries: w.summaries() });
    for (const command of COMMANDS) {
      await w.runCommand(`!${command.name}`);
      await w.runCommand(`!${command.name} 강분대`);
    }
    expect(JSON.stringify({ state: w.state(), transcript: w.transcript(), summaries: w.summaries() })).toBe(before);
  });

  it("!상태: 머리줄, 능력치, 상태 트랙 게이지", async () => {
    const out = await world().runCommand("!상태");
    expect(out).toContain("━━━ 신병 · 테스트 전투원 ━━━");
    expect(out).toContain("근력 +1   민첩 +2   냉정 0   감각 +1   교섭 -1");
    expect(out).toMatch(/부상  ░{8}  무사/);
  });

  it("별칭으로도 실행되고, 모르는 명령어는 가까운 것을 제안한다", async () => {
    const w = world();
    expect(await w.runCommand("!스탯")).toBe(await w.runCommand("!상태"));
    expect(await w.runCommand("!상테")).toContain("혹시 !상태 인가요?");
    expect(await w.runCommand("!아무거나길게")).toContain("!도움말");
  });

  it("숨은 목격자와 진짜 관계는 출력에 나오지 않는다 (플레이어가 느낀 태도만)", async () => {
    const w = world();
    const hidden = Object.values(w.state().deeds)[0]!.witnesses.filter((x) => x.hidden);
    const all = (await Promise.all(COMMANDS.map((c) => w.runCommand(`!${c.name}`)))).join("\n") + await w.runCommand("!인물 강분대");
    // 행적·목격자 정보를 보여 주는 명령어는 없다
    expect(all).not.toContain("목격");
    if (hidden.length > 0) expect(w.state().relations.npc_leader?.player).toBeDefined();
    // 만나기 전이므로 태도를 모른다 (진짜 관계가 바뀌었어도 드러나지 않는다)
    expect(await w.runCommand("!인물 강분대")).toContain("아직 직접 만나 본 적이 없다");
  });

  it("비밀과 세계의 진실은 어떤 명령어에도 나오지 않는다", async () => {
    const w = world();
    const all = (await Promise.all(COMMANDS.map((c) => w.runCommand(`!${c.name} 강분대`)))).join("\n");
    const npc = TEST_CONTENT.npcs.npc_leader!;
    expect(all).not.toContain(npc.secret!.content);
    for (const truth of npc.doesnt_know) expect(all).not.toContain(truth);
  });

  it("!일지: 현재 캐릭터의 요약 기록, 검색어로 거른다", async () => {
    const w = world();
    expect(await w.runCommand("!일지")).toContain("막사에서 일어났다.");
    expect(await w.runCommand("!일지 식당")).toContain("기록이 없습니다");
  });

  it("!도움말은 모든 명령어를 보여 준다", async () => {
    const out = runCommand("!도움말", { state: world().state(), content: TEST_CONTENT, summaries: [] });
    for (const c of COMMANDS) expect(out).toContain(`!${c.name}`);
  });
});
