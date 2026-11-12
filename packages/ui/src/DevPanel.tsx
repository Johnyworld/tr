import { useEffect, useState } from "react";
import { fetchRetrievals, type RetrievalView } from "./api.ts";

/**
 * 개발용 패널: 최근 턴에 어떤 lore 청크가 왜(점수, 경로) GM 컨텍스트에 들어갔는지 (기획서 11.4).
 * 정보 필터를 거친 결과만 보인다. 필터로 빠진 청크는 개수만 나온다.
 */
export function DevPanel({ refreshKey }: { refreshKey: unknown }) {
  const [records, setRecords] = useState<RetrievalView[]>([]);
  useEffect(() => {
    fetchRetrievals().then(setRecords).catch(() => undefined);
  }, [refreshKey]);
  const last = records.at(-1);
  return (
    <section className="dev">
      <details>
        <summary>
          <h3>개발: RAG 검색</h3>
        </summary>
        {!last ? (
          <div className="muted small">검색 기록이 없습니다</div>
        ) : (
          <div className="small">
            <div className="muted">
              턴 {last.turn} · {last.purpose} · 후보 {last.trace.candidates} · 필터 제외 {last.trace.filtered} · 잘림{" "}
              {last.trace.dropped.length}
            </div>
            <div className="muted">키워드: {last.trace.keywordQuery ?? "없음"}</div>
            <ol className="dev-hits">
              {last.trace.hits.map((h) => (
                <li key={h.id}>
                  {h.id} <span className="muted">· {h.score} · 벡터 {h.vectorRank ?? "-"} · 키워드 {h.keywordRank ?? "-"}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </details>
    </section>
  );
}
