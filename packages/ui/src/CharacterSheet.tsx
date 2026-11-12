import { signed } from "./ToolCard.tsx";
import type { PlayerView } from "./types.ts";

export function CharacterSheet({ player }: { player: PlayerView }) {
  return (
    <aside className="sheet" aria-label="캐릭터 시트">
      <h2>{player.name}</h2>
      <div className="sheet-sub">세력 A · 하급 전투원</div>

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
