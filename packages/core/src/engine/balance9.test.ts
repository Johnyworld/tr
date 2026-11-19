import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { makeFamily } from "../game/startGroup.ts";
import { createSeededRng } from "../rng.ts";

/** 긴 판의 균형 (플레이 테스트 9, 12-195) */
const content = loadRealContent();
const relationKind = (id: string) => content.scenario.custom_start!.group!.relations.find((r) => r.id === id)!.kind;
const families = (age: number, n = 60) =>
  Array.from({ length: n }, (_, i) => makeFamily(content, { age, gender: "female" }, 3, createSeededRng(i + 1), "김").map((m) => ({ kind: relationKind(m.relation), age: m.age })));

describe("찾는 가족의 나이 (12-195)", () => {
  it("24세 아래는 부모·형제만, 28세 아래는 자식이 없다", () => {
    for (const f of families(22)) expect(f.every((m) => m.kind === "parent" || m.kind === "sibling")).toBe(true);
    for (const f of families(25)) expect(f.some((m) => m.kind === "child")).toBe(false);
  });

  it("나이가 돼도 결혼·자식은 확률로: 30세에도 배우자가 없는 가족이 있고, 자식은 18살 이상 어리다", () => {
    const all = families(30);
    expect(all.some((f) => !f.some((m) => m.kind === "spouse"))).toBe(true);
    expect(all.some((f) => f.some((m) => m.kind === "spouse"))).toBe(true);
    for (const f of all) for (const m of f) if (m.kind === "child") expect(m.age).toBeLessThanOrEqual(30 - 18);
  });
});
