import { signed } from "./ToolCard.tsx";
import type { PlayerView } from "./types.ts";

export function CharacterSheet({ player }: { player: PlayerView }) {
  return (
    <aside className="sheet" aria-label="캐릭터 시트">
      <h2>{player.name}</h2>
      <div className="sheet-sub">{player.roleLabel}</div>

      <section>
        <h3>부상</h3>
        <div className={`injury injury-${player.injury}`}>
          {player.injuryLabel}
          {player.injuryPenalty !== 0 && <span className="penalty"> (판정 {signed(player.injuryPenalty)})</span>}
        </div>
      </section>

      <section>
        <h3>능력치</h3>
        <dl className="stats">
          {player.stats.map((s) => (
            <div key={s.id}>
              <dt>{s.label}</dt>
              <dd>{signed(s.value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mission">
        <h3>임무</h3>
        {player.mission ? (
          <div>
            <div className="mission-title">{player.mission.title}</div>
            <div className="muted small">기한 {player.mission.deadlineLabel}</div>
            <ul className="requirements">
              {player.mission.requirements.map((r) => (
                <li key={r} className={r.includes("미충족") ? "" : "met"}>
                  {r}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="muted">없음</div>
        )}
      </section>

      <section className="service">
        <h3>복무</h3>
        <div>
          공적 {player.service.merit} · 복무 {player.service.daysServed}일
          {player.service.disobedience > 0 && <span className="injury-light"> · 불복종 {player.service.disobedience}</span>}
        </div>
        {player.service.promotionMissing && player.service.promotionMissing.length > 0 && (
          <div className="muted small">진급까지: {player.service.promotionMissing.join(", ")}</div>
        )}
      </section>

      <section className="present">
        <h3>함께 있는 인물</h3>
        {player.present.length === 0 ? (
          <div className="muted">없음</div>
        ) : (
          <ul className="people">
            {player.present.map((p) => (
              <li key={p.id} title={p.look}>
                {p.name} <span className="muted">· {p.rankLabel}</span>
                {p.injuryLabel !== "무사" && <span className="injury-light"> · {p.injuryLabel}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>소지품</h3>
        <ItemList items={player.inventory} />
      </section>

      {player.sceneItems.length > 0 && (
        <section className="scene">
          <h3>주변에 놓인 물건</h3>
          <ItemList items={player.sceneItems} />
        </section>
      )}
      <section className="beliefs">
        <details>
          <summary>
            <h3>아는 것 ({player.beliefs.length})</h3>
          </summary>
          <ul>
            {player.beliefs.map((b) => (
              <li key={b.id}>
                <span className="belief-source">{b.sourceLabel}</span> {b.fact}
              </li>
            ))}
          </ul>
        </details>
      </section>
    </aside>
  );
}

function ItemList({ items }: { items: PlayerView["inventory"] }) {
  if (items.length === 0) return <div className="muted">없음</div>;
  return (
    <ul className="items">
      {items.map((item) => (
        <li key={item.id}>
          {item.name}
          {item.quantity > 1 && <span className="muted"> ×{item.quantity}</span>}
        </li>
      ))}
    </ul>
  );
}
