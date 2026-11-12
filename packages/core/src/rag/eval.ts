import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Embedder } from "./embedder.ts";
import { DEFAULT_SEARCH, RagIndex, canSeeChunk, type IndexChunk, type SearchHit, type SearchOptions, type Viewer } from "./index.ts";
import { MAX_CHUNK_CHARS } from "./chunk.ts";
import { readLoreDocs } from "./lore.ts";

/**
 * RAG 검색 평가 (기획서 11.4).
 * content/scenarios/<id>/eval/retrieval.yaml 의 (질의, 검색자, 기대 청크) 목록으로
 * recall@k, MRR, 정보 필터 위반 수를 잰다. 청크 크기·top-k·하이브리드 가중치를 바꿔 가며 비교할 수 있다.
 */

const viewerSchema = z.strictObject({
  character: z.string().min(1).optional(),
  faction: z.string().min(1),
  flags: z.array(z.string()).default([]),
});

/** lore/<문서>, lore/<문서> > <절>, memory:<id> */
const targetSchema = z.string().regex(/^(lore\/[a-z0-9_]+( > .+)?|memory:[a-z0-9_]+)$/);

export const retrievalEvalSchema = z.strictObject({
  viewers: z.record(z.string(), viewerSchema),
  memory: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9_]+$/),
        kind: z.enum(["turn_summary", "scene_summary", "deed", "belief"]),
        known_by: z.array(z.string()).min(1),
        text: z.string().min(1),
      }),
    )
    .default([]),
  cases: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        query: z.string().min(1),
        viewer: z.string().min(1),
        collection: z.enum(["lore", "memory"]).default("lore"),
        expect: z.array(targetSchema),
        forbid: z.array(targetSchema).default([]),
      }),
    )
    .min(1),
});
export type RetrievalEval = z.infer<typeof retrievalEvalSchema>;

export class RetrievalEvalError extends Error {
  override name = "RetrievalEvalError";
}

/** 평가 세트를 읽고 검증한다 (검색자·기억 참조가 실제로 있는지까지) */
export function loadRetrievalEval(scenarioDir: string): RetrievalEval {
  const path = join(scenarioDir, "eval", "retrieval.yaml");
  const parsed = retrievalEvalSchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new RetrievalEvalError(`${path}\n${z.prettifyError(parsed.error)}`);
  const data = parsed.data;
  const memoryIds = new Set(data.memory.map((m) => m.id));
  const loreSources = new Map(readLoreDocs(join(scenarioDir, "lore")).map((d) => [d.sourceId, new Set(d.chunks.map((c) => c.section))]));
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of data.cases) {
    if (ids.has(c.id)) problems.push(`${c.id}: 중복된 id`);
    ids.add(c.id);
    if (!data.viewers[c.viewer]) problems.push(`${c.id}: 모르는 검색자 ${c.viewer}`);
    for (const t of [...c.expect, ...c.forbid]) {
      const target = parseTarget(t);
      if (target.kind === "memory" && !memoryIds.has(target.id)) problems.push(`${c.id}: 없는 기억 ${t}`);
      if (target.kind === "lore") {
        const sections = loreSources.get(target.sourceId);
        if (!sections) problems.push(`${c.id}: 없는 lore 문서 ${t}`);
        else if (target.section !== null && !sections.has(target.section)) problems.push(`${c.id}: 없는 절 ${t}`);
      }
    }
  }
  if (problems.length) throw new RetrievalEvalError(`${path}\n${problems.join("\n")}`);
  return data;
}

type Target = { kind: "lore"; sourceId: string; section: string | null } | { kind: "memory"; id: string };

function parseTarget(target: string): Target {
  if (target.startsWith("memory:")) return { kind: "memory", id: target.slice("memory:".length) };
  const [sourceId, section] = target.split(" > ") as [string, string | undefined];
  return { kind: "lore", sourceId, section: section ?? null };
}

function matches(target: Target, hit: Pick<SearchHit, "id" | "sourceId" | "section">): boolean {
  if (target.kind === "memory") return hit.id === `memory:${target.id}`;
  return hit.sourceId === target.sourceId && (target.section === null || hit.section === target.section);
}

export type RetrievalEvalConfig = {
  /** lore 청크 최대 글자 수 */
  chunkChars: number;
  search: Required<Omit<SearchOptions, "exclude">>;
};

export const DEFAULT_EVAL_CONFIG: RetrievalEvalConfig = { chunkChars: MAX_CHUNK_CHARS, search: DEFAULT_SEARCH };

export type CaseResult = {
  id: string;
  query: string;
  viewer: string;
  collection: "lore" | "memory";
  /** 기대한 것 중 찾은 것 / 못 찾은 것 */
  found: string[];
  missed: string[];
  /** 기대가 없으면 null */
  recall: number | null;
  /** 처음으로 맞힌 결과의 역순위 (1/순위), 못 맞히면 0 */
  reciprocalRank: number | null;
  /** 정보 필터 위반 (forbid가 나왔거나, 검색자가 볼 수 없는 청크가 나옴) */
  violations: string[];
  hits: { id: string; label: string; score: number; vectorRank: number | null; keywordRank: number | null }[];
};

export type RetrievalEvalReport = {
  config: RetrievalEvalConfig;
  embedderId: string;
  cases: CaseResult[];
  /** 기대가 있는 사례들의 평균 */
  recallAtK: number;
  /** 첫 결과가 기대한 것인 비율 */
  hitAt1: number;
  mrr: number;
  violations: number;
};

/** 평가 세트를 새 색인(메모리 DB)에 넣고 돌린다. 실제 세이브·lore 색인은 건드리지 않는다 */
export async function runRetrievalEval(
  scenarioDir: string,
  data: RetrievalEval,
  embedder: Embedder,
  config: RetrievalEvalConfig = DEFAULT_EVAL_CONFIG,
): Promise<RetrievalEvalReport> {
  const loreDocs = readLoreDocs(join(scenarioDir, "lore"), config.chunkChars);
  const lore = RagIndex.open(":memory:", embedder);
  const memory = RagIndex.open(":memory:", embedder);
  try {
    await lore.sync(loreDocs);
    const memoryItems: IndexChunk[] = data.memory.map((m) => ({
      id: `memory:${m.id}`,
      sourceId: `memory/${m.kind}`,
      title: m.kind,
      section: "",
      visibility: "known_by",
      kind: m.kind,
      knownBy: m.known_by,
      createdAt: null,
      text: m.text,
    }));
    await memory.upsert(memoryItems);

    // 독립 검사용: 청크 id → 공개 범위 (색인의 필터와 별개로 다시 확인한다)
    const access = new Map<string, { visibility: string; knownBy: readonly string[] | null }>();
    for (const d of loreDocs) for (const c of d.chunks) access.set(c.id, { visibility: c.visibility, knownBy: null });
    for (const m of memoryItems) access.set(m.id, { visibility: m.visibility, knownBy: m.knownBy ?? null });

    const cases: CaseResult[] = [];
    for (const c of data.cases) {
      const v = data.viewers[c.viewer]!;
      const viewer: Viewer = { characterId: v.character, factionId: v.faction, flags: new Set(v.flags) };
      const { hits, trace } = await (c.collection === "memory" ? memory : lore).search(c.query, viewer, config.search);

      const violations: string[] = [];
      const traceText = JSON.stringify(trace);
      for (const f of c.forbid) {
        const target = parseTarget(f);
        if (hits.some((h) => matches(target, h))) violations.push(`금지된 결과: ${f}`);
        // 잘린 청크·점수 기록에도 남으면 안 된다
        const leaked = [...access.keys()].filter((id) => traceText.includes(`"${id}"`) && matches(target, chunkRef(id, loreDocs)));
        if (leaked.length) violations.push(`검색 기록에 남음: ${f}`);
      }
      for (const h of hits) {
        const a = access.get(h.id);
        if (!a || !canSeeChunk(a, viewer)) violations.push(`볼 수 없는 청크: ${h.id}`);
      }

      const found = c.expect.filter((t) => hits.some((h) => matches(parseTarget(t), h)));
      const firstRank = hits.findIndex((h) => c.expect.some((t) => matches(parseTarget(t), h)));
      cases.push({
        id: c.id,
        query: c.query,
        viewer: c.viewer,
        collection: c.collection,
        found,
        missed: c.expect.filter((t) => !found.includes(t)),
        recall: c.expect.length ? found.length / c.expect.length : null,
        reciprocalRank: c.expect.length ? (firstRank >= 0 ? 1 / (firstRank + 1) : 0) : null,
        violations,
        hits: hits.map((h) => ({
          id: h.id,
          label: h.id.startsWith("memory:") ? h.id : `${h.sourceId} > ${h.section}`,
          score: h.score,
          vectorRank: h.vectorRank,
          keywordRank: h.keywordRank,
        })),
      });
    }
    const scored = cases.filter((c) => c.recall !== null);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      config,
      embedderId: embedder.id,
      cases,
      recallAtK: mean(scored.map((c) => c.recall!)),
      hitAt1: mean(scored.map((c) => (c.reciprocalRank === 1 ? 1 : 0))),
      mrr: mean(scored.map((c) => c.reciprocalRank!)),
      violations: cases.reduce((n, c) => n + c.violations.length, 0),
    };
  } finally {
    lore.close();
    memory.close();
  }
}

function chunkRef(id: string, docs: ReturnType<typeof readLoreDocs>): Pick<SearchHit, "id" | "sourceId" | "section"> {
  for (const d of docs) for (const c of d.chunks) if (c.id === id) return { id, sourceId: c.sourceId, section: c.section };
  return { id, sourceId: "", section: "" };
}

/** 사람이 읽는 보고서 */
export function formatEvalReport(report: RetrievalEvalReport, options: { verbose?: boolean } = {}): string {
  const { config } = report;
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines = [
    `임베더 ${report.embedderId} · 청크 ${config.chunkChars}자 · top-${config.search.topK} · 후보 ${config.search.candidates} · 가중치 벡터 ${config.search.weights.vector} : 키워드 ${config.search.weights.keyword}`,
    `recall@k ${pct(report.recallAtK)} · hit@1 ${pct(report.hitAt1)} · MRR ${report.mrr.toFixed(2)} · 정보 필터 위반 ${report.violations}건`,
    "",
  ];
  for (const c of report.cases) {
    const mark = c.violations.length ? "✗" : c.recall === null ? "·" : c.recall === 1 ? (c.reciprocalRank === 1 ? "✓" : "○") : c.recall > 0 ? "△" : "✗";
    lines.push(`${mark} ${c.id} [${c.viewer}/${c.collection}] ${c.query}`);
    if (c.missed.length) lines.push(`    못 찾음: ${c.missed.join(", ")}`);
    for (const v of c.violations) lines.push(`    위반: ${v}`);
    if (options.verbose || c.missed.length || c.violations.length || (c.reciprocalRank !== null && c.reciprocalRank < 1)) {
      for (const h of c.hits) lines.push(`    - ${h.label} (${h.score.toFixed(4)}, 벡터 ${h.vectorRank ?? "-"}, 키워드 ${h.keywordRank ?? "-"})`);
    }
  }
  return lines.join("\n");
}
