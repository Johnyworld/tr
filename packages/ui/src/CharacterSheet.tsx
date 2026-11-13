import { Portrait } from "./Portrait.tsx";
import type { PlayerView } from "./types.ts";

export function CharacterSheet({ player }: { player: PlayerView }) {
  return (
    <aside className="sheet" aria-label="캐릭터 시트">
      <div className="sheet-hero">
        <Portrait id={player.portrait} size={56} />
        <div>
          <h2>{player.name}</h2>
          <div className="sheet-sub">
            {[player.genderLabel, player.age ? `${player.age}세` : null].filter(Boolean).join(" · ")}
          </div>
          <div className="sheet-sub">{player.roleLabel}</div>
        </div>
      </div>

      <section>
        <h3>상태</h3>
        {player.conditions.map((c) => (
          <div key={c.id} className={player.dead ? "condition-dead" : c.worsened ? "condition-worse" : ""}>
            {c.label} {c.levelLabel}
          </div>
        ))}
        {player.conditionPenalty !== 0 && <div className="penalty">판정 {signed(player.conditionPenalty)}</div>}
      </section>

      <section>
        <h3>능력</h3>
        <dl className="stats">
          {player.stats.map((s) => (
            <div key={s.id}>
              <dt>{s.label}</dt>
              <dd>{signed(s.value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {player.traits.length > 0 && (
        <section className="traits">
          <h3>트레잇</h3>
          <div className="trait-chips">
            {player.traits.map((t) => (
              <span key={t.id} className={`trait-chip ${t.kind}`} title={t.description}>
                {t.label}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="skills">
        <h3>스킬</h3>
        <dl className="stats">
          {player.skills.map((s) => (
            <div key={s.id}>
              <dt>
                {s.label} <span className="muted small">{s.category}</span>
              </dt>
              <dd>{signed(s.value)}</dd>
            </div>
          ))}
        </dl>
        {player.growth && (
          <div className="muted small">
            레벨 {player.growth.level} · 경험치 {player.growth.xp}/{player.growth.next}
            {player.growth.skillPoints > 0 && <span className="condition-worse"> · 올릴 스킬 {player.growth.skillPoints}개</span>}
          </div>
        )}
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
        <h3>{player.faction ? "복무" : "지낸 날"}</h3>
        <div>
          {player.faction ? `공적 ${player.service.merit} · 복무 ${player.service.daysServed}일` : `${player.service.daysServed}일째 (무소속)`}
          {player.service.disobedience > 0 && <span className="condition-worse"> · 불복종 {player.service.disobedience}</span>}
        </div>
        {player.service.promotionMissing && player.service.promotionMissing.length > 0 && (
          <div className="muted small">진급까지: {player.service.promotionMissing.join(", ")}</div>
        )}
      </section>

      {player.battle && (
        <section className="sheet-battle">
          <h3>
            {player.battle.title} <span className="muted small">({player.battle.sideLabel} · {player.battle.round}라운드)</span>
          </h3>
          <div className="gauge-row" title={`전세 ${player.battle.momentum}`}>
            전세 {"◀".repeat(Math.max(0, -player.battle.momentum))}
            {"·".repeat(player.battle.momentumMax - Math.abs(player.battle.momentum))}
            {"▶".repeat(Math.max(0, player.battle.momentum))} {player.battle.momentumLabel}
          </div>
          <div className="muted small">
            경보 {player.battle.alarmLabel} · 위치 {player.battle.positionLabel}
          </div>
        </section>
      )}

      {player.faction && (
        <section className="faction">
          <h3>무리</h3>
          <div>
            {player.faction.name} · 분위기 {player.faction.moraleLabel}
          </div>
          <div className="muted small">배급: {player.faction.rationLabel}</div>
          {player.zone && <div className="muted small">있는 곳: {player.zone.name} ({player.zone.owner})</div>}
        </section>
      )}

      <section className="present">
        <h3>함께 있는 인물</h3>
        {player.present.length === 0 ? (
          <div className="muted">없음</div>
        ) : (
          <ul className="people">
            {player.present.map((p) => (
              <li key={p.id} title={p.look}>
                {p.name} <span className="muted">· {p.rankLabel}</span>
                {p.conditionLabel && <span className="condition-worse"> · {p.conditionLabel}</span>}
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
      {player.relations.length > 0 && (
        <section className="relations">
          <details>
            <summary>
              <h3>관계</h3>
            </summary>
            <table>
              <thead>
                <tr>
                  <th />
                  <th>신뢰</th>
                  <th>호감</th>
                  <th>존중</th>
                </tr>
              </thead>
              <tbody>
                {player.relations.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <RelationCell value={r.trust} />
                    <RelationCell value={r.affection} />
                    <RelationCell value={r.respect} />
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}

      {player.deeds.length > 0 && (
        <section className="beliefs deeds">
          <details>
            <summary>
              <h3>내 행적 ({player.deeds.length})</h3>
            </summary>
            <ul>
              {player.deeds.map((d) => (
                <li key={d.id}>
                  <span className="belief-source">{d.tagLabels.join("·")}</span> {d.summary}
                  {d.visibleWitnesses.length > 0 && <span className="muted"> — 본 사람: {d.visibleWitnesses.join(", ")}</span>}
                </li>
              ))}
            </ul>
          </details>
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

function RelationCell({ value }: { value: number }) {
  return <td className={value > 0 ? "rel-pos" : value < 0 ? "rel-neg" : "muted"}>{signed(value)}</td>;
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

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
