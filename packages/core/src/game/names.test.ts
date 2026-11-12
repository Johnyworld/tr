import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { generateName } from "./names.ts";

const names = { surnames: ["김", "이"], given: { male: ["민준", "도윤"], female: ["서연", "지아"] } };

describe("이름 생성", () => {
  it("성별에 맞는 이름을 성과 합쳐 만든다. 쓰인 이름은 피한다", () => {
    const rng = createSeededRng(1);
    for (let i = 0; i < 20; i++) {
      const name = generateName(rng, names, "female", new Set())!;
      expect(["김", "이"]).toContain(name[0]);
      expect(["서연", "지아"]).toContain(name.slice(1));
    }
    const used = new Set(["김서연", "김지아", "이서연"]);
    expect(generateName(createSeededRng(2), names, "female", used)).toBe("이지아");
  });

  it("재료가 없으면 null, 다 쓰였으면 구분 숫자를 붙인다", () => {
    expect(generateName(createSeededRng(1), undefined, null, new Set())).toBeNull();
    const all = new Set(["김민준", "김도윤", "이민준", "이도윤"]);
    expect(generateName(createSeededRng(1), names, "male", all)).toMatch(/^[김이](민준|도윤)\d$/);
  });
});
