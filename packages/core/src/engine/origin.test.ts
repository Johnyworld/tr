import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { createExtraCharacter, originLine } from "./extras.ts";

/** 출신과 말씨 (12-142): 동적으로 생기는 사람의 출신을 인구 비율로, 사투리는 확률로 */
const content = loadRealContent();
const person = content.extras.a_scout!;
const dog = content.extras.stray_dog!;
const make = (template = person, rng = createSeededRng(7)) =>
  createExtraCharacter(content, template, { id: "ex_t", label: "사람", zone: null, time: 0, usedNames: new Set() }, rng);

describe("출신과 말씨", () => {
  it("수도권(표준어)이 가장 많고 경상도가 다음, 제주·함경도가 가장 적다", () => {
    const rng = createSeededRng(11);
    const count: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) {
      const o = make(person, rng).origin!;
      count[o.id] = (count[o.id] ?? 0) + 1;
    }
    const order = Object.entries(count).sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(order[0]).toBe("capital");
    expect(order[1]).toBe("gyeongsang");
    expect(count.jeju!).toBeLessThan(count.gangwon!);
    expect(count.hamgyeong!).toBeLessThan(count.gangwon!);
  });

  it("지방 출신이어도 표준어를 쓸 수 있고, 수도권은 늘 표준어. 동물은 출신이 없다", () => {
    const rng = createSeededRng(3);
    const all = Array.from({ length: 800 }, () => make(person, rng).origin!);
    const gs = all.filter((o) => o.id === "gyeongsang");
    expect(gs.some((o) => o.dialect)).toBe(true);
    expect(gs.some((o) => !o.dialect)).toBe(true);
    expect(all.filter((o) => o.id === "capital").every((o) => !o.dialect)).toBe(true);
    expect(make(dog).origin).toBeNull();
  });

  it("GM 카드의 말씨 줄: 사투리를 쓰면 말씨와 예문, 아니면 표준어", () => {
    expect(originLine(content, { origin: { id: "jeolla", dialect: true } })).toContain("전라도 사투리");
    expect(originLine(content, { origin: { id: "jeolla", dialect: false } })).toContain("표준어");
    expect(originLine(content, { origin: null })).toBeNull();
  });
});
