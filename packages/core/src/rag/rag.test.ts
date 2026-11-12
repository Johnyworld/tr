import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chunkLore, LoreFormatError, parseLoreFile } from "./chunk.ts";
import { HashEmbedder } from "./embedder.ts";
import { canSee, keywordQuery, RagIndex, type SourceDoc, type Viewer } from "./index.ts";

const doc = (id: string, visibility: string, body: string, hash = "h1"): SourceDoc => ({
  sourceId: id,
  hash,
  chunks: chunkLore(id, `---\ntitle: ${id}\nvisibility: ${visibility}\n---\n${body}`),
});

const A: Viewer = { factionId: "faction_a", flags: new Set() };

describe("청킹", () => {
  it("절 단위로 나누고 맥락 머리를 붙인다", () => {
    const chunks = chunkLore("lore/a", "---\ntitle: 붕괴\n---\n## 첫 겨울\n도시가 무너졌다.\n\n## 감염\n소리에 반응한다.");
    expect(chunks.map((c) => c.text)).toEqual(["[붕괴 > 첫 겨울]\n도시가 무너졌다.", "[붕괴 > 감염]\n소리에 반응한다."]);
    expect(chunks[0]).toMatchObject({ id: "lore/a#1", visibility: "public" });
  });

  it("작성자 메모(HTML 주석)는 청크가 되지 않는다", () => {
    const chunks = chunkLore("lore/c", "---\ntitle: 메모\n---\n<!-- 초안 -->\n\n## 절\n본문.");
    expect(chunks.map((c) => c.text)).toEqual(["[메모 > 절]\n본문."]);
  });

  it("긴 절은 문단을 모아 자른다", () => {
    const para = "가".repeat(300);
    const chunks = chunkLore("lore/b", `---\ntitle: 긴 글\n---\n## 절\n${para}\n\n${para}\n\n${para}`, 600);
    expect(chunks.length).toBe(2);
  });

  it("앞머리가 없거나 공개 범위 형식이 틀리면 오류", () => {
    expect(() => parseLoreFile("x", "본문만")).toThrow(LoreFormatError);
    expect(() => parseLoreFile("x", "---\ntitle: t\nvisibility: everyone\n---\n본문")).toThrow(LoreFormatError);
  });
});

describe("공개 범위", () => {
  it("public, 같은 세력, 플래그를 가진 캐릭터만 본다", () => {
    expect(canSee("public", A)).toBe(true);
    expect(canSee("faction:faction_a", A)).toBe(true);
    expect(canSee("faction:faction_c", A)).toBe(false);
    expect(canSee("secret:c_prisoners", A)).toBe(false);
    expect(canSee("secret:c_prisoners", { ...A, flags: new Set(["c_prisoners"]) })).toBe(true);
    expect(canSee("weird", A)).toBe(false);
  });
});

describe("키워드 검색어", () => {
  it("조사를 뗀 말과 원래 말을 함께 찾고, 3글자 이상만 쓴다 (trigram)", () => {
    expect(keywordQuery("강태호는 어디 있나")).toBe('"강태호는" OR "강태호"');
    // "고가도로"의 "로"는 조사가 아니다: 원래 말도 함께 찾는다 (회귀)
    expect(keywordQuery("고가도로 감염체")).toBe('"고가도로" OR "고가도" OR "감염체"');
    expect(keywordQuery("응")).toBeNull();
  });
});

describe("RagIndex", () => {
  const docs = [
    doc("lore/overpass", "public", "## 고가도로\n북쪽 고가도로 아래에는 감염체가 무리 지어 모인다."),
    doc("lore/ration", "faction:faction_a", "## 배급\n세력 A의 배급은 하루 한 번 식당에서 나눠 준다."),
    doc("lore/c_inside", "faction:faction_c", "## 공포\n세력 C의 병사들은 지도자를 두려워해 복종한다."),
    doc("lore/prisoners", "secret:c_prisoners", "## 수용소\n실종된 정찰조는 C의 수용소에 갇혀 있다."),
  ];

  it("벡터와 키워드 결과를 RRF로 합치고, 어느 경로로 들어왔는지 남긴다", async () => {
    const index = RagIndex.open(":memory:", new HashEmbedder());
    await index.sync(docs);
    const { hits, trace } = await index.search("고가도로 감염체", A);
    expect(hits[0]?.sourceId).toBe("lore/overpass");
    expect(hits[0]?.keywordRank).toBe(1);
    expect(hits[0]?.vectorRank).not.toBeNull();
    expect(trace.keywordQuery).toBe('"고가도로" OR "고가도" OR "감염체"');
    index.close();
  });

  it("볼 수 없는 청크는 결과에 절대 나오지 않는다 (다른 세력, 비밀)", async () => {
    const index = RagIndex.open(":memory:", new HashEmbedder());
    await index.sync(docs);
    for (const q of ["세력 C 병사 공포 지도자", "실종된 정찰조 수용소", "배급 식당"]) {
      const { hits, trace } = await index.search(q, A, { topK: 10 });
      expect(hits.some((h) => h.sourceId === "lore/c_inside" || h.sourceId === "lore/prisoners")).toBe(false);
      expect(JSON.stringify(trace)).not.toContain("c_inside");
      expect(JSON.stringify(trace)).not.toContain("prisoners");
    }
    const withFlag = await index.search("실종된 정찰조 수용소", { ...A, flags: new Set(["c_prisoners"]) });
    expect(withFlag.hits[0]?.sourceId).toBe("lore/prisoners");
    index.close();
  });

  it("개수와 글자 예산으로 자르고 잘린 것을 기록한다", async () => {
    const index = RagIndex.open(":memory:", new HashEmbedder());
    await index.sync(docs);
    const { hits, trace } = await index.search("감염체 배급", A, { topK: 1 });
    expect(hits).toHaveLength(1);
    expect(trace.dropped.length).toBeGreaterThan(0);
    index.close();
  });

  it("해시가 같은 문서는 건너뛰고, 바뀐 문서만 다시 임베딩하고, 없어진 문서는 지운다", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "trpg-rag-")), "lore.db");
    let index = RagIndex.open(path, new HashEmbedder());
    expect(await index.sync(docs)).toMatchObject({ added: 4, chunks: 4 });
    index.close();

    index = RagIndex.open(path, new HashEmbedder());
    const changed = [docs[0]!, { ...doc("lore/ration", "faction:faction_a", "## 배급\n배급이 줄었다.", "h2") }, docs[2]!];
    expect(await index.sync(changed)).toEqual({ added: 0, updated: 1, removed: 1, unchanged: 2, chunks: 1 });
    expect(index.count()).toBe(3);
    const { hits } = await index.search("배급이 줄었다", A, { topK: 1 });
    expect(hits[0]?.text).toContain("배급이 줄었다");
    index.close();
  });

  it("임베딩 모델이 바뀌면 색인을 비우고 다시 만든다", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "trpg-rag-")), "lore.db");
    let index = RagIndex.open(path, new HashEmbedder(128));
    await index.sync(docs);
    index.close();
    index = RagIndex.open(path, new HashEmbedder(64));
    expect(index.count()).toBe(0);
    expect(await index.sync(docs)).toMatchObject({ added: 4 });
    index.close();
  });
});
