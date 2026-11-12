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
              {m.injury !== 0 && <> · 부상 {signed(m.injury)}</>}
            </span>
            <span className="total">= {display.total}</span>
          </div>
        </div>
      );
    }
    case "harm":
      return (
        <div className={`card harm ${display.to === "dead" ? "dead" : ""}`}>
          <div className="card-head">
            <span className="card-kind">부상</span>
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
