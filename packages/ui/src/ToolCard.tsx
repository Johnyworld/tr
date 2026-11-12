import type { ToolDisplayEvent } from "@trpg/core";

export function ToolCard({ display }: { display: ToolDisplayEvent }) {
  switch (display.type) {
    case "check": {
      const { modifiers: m } = display;
      return (
        <div className={`card check ${display.outcome}`}>
          <div className="card-head">
            <span className="card-kind">판정</span>
            <span>
              {display.moveLabel} · {display.statLabel} · {display.difficultyLabel}
            </span>
            <span className="badge">{display.outcomeLabel}</span>
          </div>
          <div className="card-intent">{display.intent}</div>
          <div className="dice-line">
            <span className="die">{display.dice[0]}</span>
            <span className="die">{display.dice[1]}</span>
            <span className="mods">
              {display.statLabel} {signed(m.stat)} · 난이도 {signed(m.difficulty)}
              {m.condition !== 0 && <> · 상태 {signed(m.condition)}</>}
            </span>
            <span className="total">= {display.total}</span>
          </div>
        </div>
      );
    }
    case "harm":
      return (
        <div className={`card harm ${display.fatal ? "dead" : ""}`}>
          <div className="card-head">
            <span className="card-kind">{display.trackLabel}</span>
            <span>
              {display.fromLabel} → <strong>{display.toLabel}</strong>
            </span>
            <span className="badge">{display.severityLabel}</span>
          </div>
          <div className="card-intent">{display.cause}</div>
        </div>
      );
    case "time":
      return (
        <div className={`card time ${display.interruptDetail ? "interrupted" : ""}`}>
          <div className="card-head">
            <span className="card-kind">시간</span>
            <span>
              {display.activityLabel} · {display.durationLabel}
            </span>
            <span className="time-to">{display.toLabel}</span>
          </div>
          {display.interruptDetail && <div className="card-intent">중간에 멈춤: {display.interruptDetail}</div>}
        </div>
      );
    case "mission": {
      const kind = { assigned: "임무 배정", reported: "임무 보고", abandoned: "임무 포기", expired: "임무 실패" }[display.event];
      return (
        <div className={`card mission ${display.event}`}>
          <div className="card-head">
            <span className="card-kind">{kind}</span>
            <span>{display.title}</span>
            <span className="badge">
              {display.detail}
              {display.merit !== undefined && ` · 공적 ${signed(display.merit)}`}
            </span>
          </div>
        </div>
      );
    }
    case "promotion":
      return (
        <div className="card promotion">
          <div className="card-head">
            <span className="card-kind">진급</span>
            <span>
              {display.name}: {display.fromLabel} → <strong>{display.toLabel}</strong>
            </span>
          </div>
        </div>
      );
    case "deed":
      return (
        <div className="card deed">
          <div className="card-head">
            <span className="card-kind">행적</span>
            <span>{display.summary}</span>
            <span className="badge">{display.tagLabels.join("·")}</span>
          </div>
          <div className="card-intent">
            {display.visibleWitnesses.length > 0 ? `본 사람: ${display.visibleWitnesses.join(", ")}` : "이름이 알려진 목격자는 없다"}
          </div>
        </div>
      );
    case "presence":
      return (
        <div className="card presence">
          <div className="card-head">
            <span className="card-kind">{display.action === "enter" ? "등장" : "퇴장"}</span>
            <span>{display.npcName}</span>
          </div>
        </div>
      );
    case "belief":
      return (
        <div className="card belief">
          <div className="card-head">
            <span className="card-kind">기억</span>
            <span>{display.fact}</span>
            <span className="badge">{display.sourceLabel}</span>
          </div>
        </div>
      );
    case "epitaph":
      return (
        <div className="card epitaph">
          <div className="card-head">
            <span className="card-kind">묘비명</span>
            <span>{display.name}</span>
          </div>
          <div className="card-intent">“{display.text}”</div>
        </div>
      );
    case "storylet":
      if (display.event === "started") return null; // 시작은 GM 서술로 드러난다
      return (
        <div className="card storylet">
          <div className="card-head">
            <span className="card-kind">이야기</span>
            <span>{display.title}</span>
            <span className="badge">{display.event === "resolved" ? display.detail : "지나감"}</span>
          </div>
        </div>
      );
    case "battle":
      return (
        <div className={`card battle ${display.event}`}>
          <div className="card-head">
            <span className="card-kind">{display.event === "started" ? "교전" : display.event === "ended" ? "전투 끝" : "전투"}</span>
            <span>{display.title}</span>
          </div>
          <div className="card-intent">{display.detail}</div>
        </div>
      );
    case "item":
      return (
        <div className="card item">
          <div className="card-head">
            <span className="card-kind">물건</span>
            <span>
              {display.itemName} ×{display.quantity}: {display.fromName} → {display.toName}
            </span>
          </div>
        </div>
      );
  }
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
