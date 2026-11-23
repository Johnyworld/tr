import { describe, expect, it } from "vitest";
import { checkStoryWhereWhen } from "../content/loader.ts";
import { loadRealContent } from "../testing.ts";

/** 설계 목록 C-6 이야기 전제 (12-279). 실제 콘텐츠로 본다 */
const content = loadRealContent();

describe("이야기 전제 (12-279)", () => {
  it("모든 이야기가 실내외(또는 장소)를 적고, 글이 말하는 시간대에만 열린다 (6-3·6-5)", () => {
    expect(checkStoryWhereWhen(content)).toEqual([]);
    const any = Object.values(content.storylets).filter((s) => s.when.indoor === "any").length;
    expect(any).toBeGreaterThan(0);
  });

  it("검사는 실내외를 빠뜨린 이야기와 시간대가 어긋난 글을 잡는다", () => {
    const s = content.storylets.lt_first_snow!;
    const bad = { ...content, storylets: { x: { ...s, id: "x", setup: "새벽 안개 속에서", when: { ...s.when, indoor: undefined, segments: ["day"] } } } };
    const problems = checkStoryWhereWhen(bad as never);
    expect(problems.some((p) => p.includes("when.indoor"))).toBe(true);
    expect(problems.some((p) => p.includes("dawn"))).toBe(true);
  });

  it("노역 할당량은 크게 다친 포로에게 열리지 않고, 장부 실패는 믿음을 깎지 않는다 (6-6·6-2)", () => {
    expect(content.storylets.cp_c_labor!.when.harm_at_most).toBe("light");
    const read = content.storylets.y_miok_ledger!.choices.find((c) => c.id === "read")!;
    expect(JSON.stringify(read.outcomes?.miss)).not.toContain("trust");
  });
});
