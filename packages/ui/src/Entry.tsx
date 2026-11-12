import { ToolCard } from "./ToolCard.tsx";
import type { TranscriptView } from "./types.ts";

/** 대화 기록 한 줄 (웹 앱 게임 화면과 MCP 상태 화면이 같이 쓴다) */
export function Entry({ entry }: { entry: TranscriptView }) {
  if (entry.kind === "tool") return <ToolCard display={entry.display} />;
  if (entry.kind === "note") {
    // MCP 모드에서 GM이 남긴 서술 요약 (서술 원문은 Claude 앱에만 있다)
    return <p className="note">{entry.text}</p>;
  }
  return (
    <div className={`turn ${entry.kind}`}>
      {entry.text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>{para}</p>
      ))}
    </div>
  );
}
