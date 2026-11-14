import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CreationStatus, NewGameView } from "./types.ts";

/**
 * 상태 화면의 새 게임·새 캐릭터 고르기 (12-67): 월드 → 시나리오 → (수위) → 캐릭터.
 * 화면은 core가 준 단계(newGameView)를 그리고, 고른 것을 채팅과 같은 말로 보낸다. 검증과 계산은 core가 한다.
 * 다 고르면 Claude 세션에서 기다리던 GM이 첫 장면을 서술한다
 */
export function NewGame({ creation }: { creation: CreationStatus }) {
  const { view, gmWorking } = creation;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 단계가 바뀌면 오류를 지운다
  const stepKey = `${view.step}:${view.character?.index.at ?? ""}`;
  useEffect(() => setError(null), [stepKey]);

  const send = async (body: { answer?: string | string[]; back?: boolean; chat?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/creation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !out.ok) setError(out.error ?? "보내지 못했다.");
    } catch {
      setError("Claude 세션과 연결이 끊겼다.");
    } finally {
      setBusy(false);
    }
  };
  const answer = (a: string | string[]) => void send({ answer: a });
  const canBack = !(view.step === "world" || (view.mode === "heir" && view.step === "name" && (view.character?.index.at ?? 1) === 1));

  return (
    <div className="newgame">
      <div className="newgame-top">
        {canBack ? (
          <button type="button" className="newgame-back" disabled={busy || gmWorking} onClick={() => void send({ back: true })}>
            ← 뒤로
          </button>
        ) : (
          <span />
        )}
        <span className="newgame-crumb">{crumb(view)}</span>
        <button type="button" className="newgame-chat" disabled={busy} onClick={() => void send({ chat: true })} title="이 단계부터 채팅에서 GM과 이어 고른다">
          채팅으로
        </button>
      </div>
      {gmWorking ? (
        <div className="newgame-wait">
          <div className="newgame-spinner" aria-hidden="true" />
          <p>GM이 쓴 이야기를 이 세계의 사람과 장소로 옮기고 있다. 잠시 뒤 이어서 고른다.</p>
        </div>
      ) : (
        <Step view={view} busy={busy} answer={answer} />
      )}
      {error && (
        <p className="newgame-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function crumb(view: NewGameView): string {
  if (view.step === "world") return "새 게임 · 월드";
  if (view.step === "scenario") return `${view.world?.title} · 시나리오`;
  if (view.step.startsWith("custom")) return `${view.world?.title} · 직접 만들기`;
  if (view.step === "content") return `${view.world?.title} · 수위`;
  const c = view.character;
  const who = view.mode === "heir" ? "새 캐릭터" : "캐릭터";
  return c ? `${who} ${c.index.at}/${c.index.total}` : who;
}

type StepProps = { view: NewGameView; busy: boolean; answer: (a: string | string[]) => void };

function Step({ view, busy, answer }: StepProps) {
  switch (view.step) {
    case "world":
      return (
        <>
          <h2 className="newgame-title">어느 월드에서 시작할까</h2>
          <div className="choice-list">
            {view.worlds!.map((w) => (
              <button key={w.id} type="button" className="choice-card" disabled={busy} onClick={() => answer(w.id)}>
                <strong>{w.title}</strong>
                {w.tagline && <span className="choice-tagline">{w.tagline}</span>}
                {w.description && <span className="choice-desc">{w.description}</span>}
              </button>
            ))}
          </div>
          {view.premise && <p className="newgame-premise">{view.premise}</p>}
        </>
      );
    case "scenario": {
      const custom = view.scenarios!.filter((r) => r.custom);
      const fixed = view.scenarios!.filter((r) => !r.custom);
      return (
        <>
          <Story text={view.world!.intro} title={`${view.world!.title} 이야기`} />
          <h2 className="newgame-title">어떤 사람으로 시작할까</h2>
          {custom.map((r) => (
            <button key={r.id} type="button" className="choice-card featured" disabled={busy} onClick={() => answer(r.id)}>
              <strong>{r.title}</strong>
              <span className="choice-desc">{r.pitch}</span>
            </button>
          ))}
          {fixed.length > 0 && <h3 className="newgame-sub">추천 시작</h3>}
          <div className="choice-list">
            {fixed.map((r) => (
              <button key={r.id} type="button" className="choice-card" disabled={busy} onClick={() => answer(r.id)}>
                <strong>{r.title}</strong>
                <span className="choice-desc">{r.pitch}</span>
              </button>
            ))}
          </div>
        </>
      );
    }
    case "custom_story":
      return <CustomStory view={view} busy={busy} answer={answer} />;
    case "custom_setup":
      return (
        <div className="newgame-wait">
          <div className="newgame-spinner" aria-hidden="true" />
          <p>GM이 이야기를 옮기고 있다.</p>
        </div>
      );
    case "custom_confirm":
      return (
        <>
          <h2 className="newgame-title">이렇게 옮겼다</h2>
          <div className="newgame-box">
            {view.custom!.result!.map((line, i) => (
              <p key={i} className="pre-line">
                {line}
              </p>
            ))}
          </div>
          <div className="newgame-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => answer("confirm")}>
              이대로
            </button>
            <button type="button" disabled={busy} onClick={() => answer("remap")}>
              다시 옮기기
            </button>
            <button type="button" disabled={busy} onClick={() => answer("rewrite")}>
              다시 쓰기
            </button>
          </div>
        </>
      );
    case "content":
      return (
        <>
          <h2 className="newgame-title">성인 주제를 다룰까</h2>
          <div className="choice-list">
            <button type="button" className="choice-card" disabled={busy} onClick={() => answer("off")}>
              <strong>끄기 (기본)</strong>
              <span className="choice-desc">연애나 성적인 이야기는 나오지 않는다. 폭력과 죽음, 생존의 잔혹함은 어느 쪽이든 나온다.</span>
            </button>
            <button type="button" className="choice-card" disabled={busy} onClick={() => answer("on")}>
              <strong>켜기</strong>
              <span className="choice-desc">
                성인 사이의 끌림과 연애(장면은 암전), 성적인 농담·괴롭힘·위협(시도까지만)이 나올 수 있다. {view.content!.adultAge}세 미만은 어떤 경우에도 그 대상이
                되지 않는다.
              </span>
            </button>
          </div>
          <p className="newgame-note">게임 중에도 설정(톱니바퀴)에서 바꿀 수 있다.</p>
        </>
      );
    default:
      return <CharacterStep view={view} busy={busy} answer={answer} />;
  }
}

/** 마크다운 조금(## 제목, - 목록)만 읽는 이야기 상자 */
function Story({ text, title }: { text: string; title?: string }) {
  const blocks = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <details className="newgame-story" open>
      <summary>{title ?? "이야기"}</summary>
      {blocks.map((line, i) =>
        line.startsWith("#") ? (
          <h4 key={i}>{line.replace(/^#+\s*/, "")}</h4>
        ) : line.startsWith("- ") ? (
          <p key={i} className="story-item">
            {line.slice(2)}
          </p>
        ) : (
          <p key={i}>{line}</p>
        ),
      )}
    </details>
  );
}

function CustomStory({ view, busy, answer }: StepProps) {
  const c = view.custom!;
  const [story, setStory] = useState(c.story ?? "");
  return (
    <>
      <h2 className="newgame-title">누구로 시작할까</h2>
      <p className="newgame-note">
        서너 문장이면 된다. 어느 무리 사람인지(또는 무리 없이 떠도는지), 무리에서 무슨 일을 하는지, 몇 살쯤인지, 그리고 지난 일 (잃은 사람, 원수, 살아 있는 가족, 진 빚,
        도망쳐 나온 무리 등). 이 세계에 있는 무리·장소 안에서 정해지고, 한 자리뿐인 우두머리는 될 수 없다.
      </p>
      {c.occupations.length > 0 && (
        <details className="newgame-story">
          <summary>고를 수 있는 일</summary>
          {c.occupations.map((o) => (
            <p key={o.label}>
              <strong>{o.label}</strong> — {o.summary}
            </p>
          ))}
        </details>
      )}
      <textarea className="newgame-textarea" value={story} maxLength={c.maxLength} rows={7} onChange={(e) => setStory(e.target.value)} placeholder="나는…" />
      <div className="newgame-actions">
        <span className="muted small">
          {story.length}/{c.maxLength}
        </span>
        <button type="button" className="primary" disabled={busy || story.trim().length === 0} onClick={() => answer(story.trim())}>
          이 이야기로
        </button>
      </div>
    </>
  );
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function CharacterStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const step = view.step;
  const options = c.options;
  return (
    <>
      {c.situation && step === "name" && c.index.at === 1 && (
        <>
          <Story text={c.situation} title="지금 상황" />
          {c.startSkills.length > 0 && (
            <p className="newgame-note">
              {c.roleLabel} · 시작 훈련 {c.startSkills.map((x) => `${x.label} ${signed(x.value)}`).join(", ")}
            </p>
          )}
        </>
      )}
      <Chosen view={view} />
      {step === "name" && <NameStep view={view} busy={busy} answer={answer} />}
      {(step === "gender" || step === "abilities" || step === "traits") && (
        <>
          <h2 className="newgame-title">{step === "gender" ? "성별" : step === "abilities" ? "타고난 능력은 어떻게 정할까" : "타고난 기질과 버릇(트레잇)은"}</h2>
          {step === "abilities" && (
            <p className="newgame-note">
              {c.tiers
                ? `직접 정하면 ${c.tiers.map((t) => `${t.label}(${signed(t.value)}) ${t.count}개`).join(", ")}를 고르고 나머지는 보통(0)이다.`
                : `모두 0에서 시작해 ${c.points?.total ?? 0}포인트를 나눠 쓴다.`}
            </p>
          )}
          {step === "traits" && c.traitLimits && (
            <p className="newgame-note">
              강점은 약점으로 얻은 포인트만큼만 가질 수 있다. 약점 {c.traitLimits.max_negative}개 · 강점 {c.traitLimits.max_positive}개 · 성격 {c.traitLimits.max_personality}개까지.
            </p>
          )}
          <div className={step === "gender" ? "choice-row" : "choice-list"}>
            {options.map((o) => (
              <button key={o.value} type="button" className="choice-card" disabled={busy} onClick={() => answer(o.value)}>
                <strong>{o.label}</strong>
                {o.description && <span className="choice-desc">{o.description}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {step === "ability_set" && (c.tiers ? <TierStep view={view} busy={busy} answer={answer} /> : <PointStep view={view} busy={busy} answer={answer} />)}
      {(step === "traits_pick" || step === "traits_personality") && <TraitStep key={step} view={view} busy={busy} answer={answer} />}
      {step === "confirm" && (
        <>
          <h2 className="newgame-title">이 사람으로 시작할까</h2>
          {c.unusedPoints > 0 && <p className="newgame-warn">능력 포인트 {c.unusedPoints}을(를) 쓰지 않았다. 이대로 시작하면 사라진다.</p>}
          <div className="newgame-actions">
            {options.map((o) => (
              <button key={o.value} type="button" className={o.value === "start" ? "primary" : ""} disabled={busy} onClick={() => answer(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** 지금까지 정한 것 */
function Chosen({ view }: { view: NewGameView }) {
  const ch = view.character!.chosen;
  if (!ch.name && !ch.gender && ch.abilities.length === 0 && !ch.traits) return null;
  return (
    <div className="newgame-chosen">
      {ch.name && <div className="chosen-name">{ch.name}</div>}
      {ch.gender && <div className="muted small">{ch.gender}</div>}
      {ch.abilities.length > 0 && (
        <div className="chosen-stats">
          {ch.abilities.map((a) => (
            <span key={a.label} className={a.value > 0 ? "up" : a.value < 0 ? "down" : ""}>
              {a.label} {signed(a.value)}
            </span>
          ))}
        </div>
      )}
      {ch.traits && <div className="muted small">트레잇: {ch.traits.length ? ch.traits.join(", ") : "없음"}</div>}
    </div>
  );
}

function NameStep({ view, busy, answer }: StepProps) {
  const [name, setName] = useState("");
  const max = view.character!.nameMax;
  return (
    <form
      className="newgame-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) answer(name.trim());
      }}
    >
      <h2 className="newgame-title">이름</h2>
      <div className="newgame-inline">
        <input className="newgame-input" value={name} maxLength={max} autoFocus onChange={(e) => setName(e.target.value)} placeholder={`1~${max}자`} />
        <button type="submit" className="primary" disabled={busy || !name.trim()}>
          다음
        </button>
      </div>
    </form>
  );
}

/** 등급 고르기: 능력마다 등급 단추. 등급별 개수가 다 차면 다음 */
function TierStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const tiers = c.tiers!;
  const [picked, setPicked] = useState<Record<string, number>>({});
  const count = (v: number) => Object.values(picked).filter((x) => x === v).length;
  const full = tiers.every((t) => count(t.value) === t.count);
  const toggle = (id: string, v: number) =>
    setPicked((p) => {
      const next = { ...p };
      if (next[id] === v) delete next[id];
      else if (count(v) < (tiers.find((t) => t.value === v)?.count ?? 0)) next[id] = v;
      return next;
    });
  const submit = () => answer(tiers.map((t) => Object.keys(picked).filter((id) => picked[id] === t.value).join(", ")).join(" / "));
  return (
    <>
      <h2 className="newgame-title">타고난 능력</h2>
      <div className="tier-legend">
        {tiers.map((t) => (
          <span key={t.value} className={count(t.value) === t.count ? "done" : ""}>
            {t.label} {signed(t.value)} · {count(t.value)}/{t.count}
          </span>
        ))}
        <span className="muted">나머지 0</span>
      </div>
      <div className="tier-table">
        {c.stats.map((s) => (
          <div key={s.id} className="tier-row">
            <div className="tier-stat">
              <strong>{s.label}</strong>
              <span className="muted small">{s.description}</span>
            </div>
            <div className="tier-buttons">
              {tiers.map((t) => {
                const on = picked[s.id] === t.value;
                const blocked = !on && count(t.value) >= t.count;
                return (
                  <button
                    key={t.value}
                    type="button"
                    className={`tier-btn ${t.value > 0 ? "up" : "down"}${on ? " on" : ""}`}
                    disabled={busy || blocked}
                    aria-pressed={on}
                    title={t.label}
                    onClick={() => toggle(s.id, t.value)}
                  >
                    {signed(t.value)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy || !full} onClick={submit}>
          다음
        </button>
      </div>
    </>
  );
}

/** (등급이 없는 월드) 포인트 나누기. 남은 포인트 표시는 비용표로 세고, 맞는지는 core가 본다 */
function PointStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const p = c.points!;
  const [values, setValues] = useState<Record<string, number>>({});
  const values0 = p.cost.map((x) => x.value);
  const min = Math.min(...values0, 0);
  const max = Math.max(...values0, 0);
  const costOf = (v: number) => p.cost.find((x) => x.value === v)?.cost ?? 0;
  const spent = Object.values(values).reduce((n, v) => n + costOf(v), 0);
  const set = (id: string, v: number) => setValues((x) => ({ ...x, [id]: Math.max(min, Math.min(max, v)) }));
  return (
    <>
      <h2 className="newgame-title">타고난 능력</h2>
      <p className="newgame-note">
        남은 포인트 {p.total - spent} · 0보다 낮추면 포인트를 돌려받는다 ({p.maxLow}개까지)
      </p>
      <div className="tier-table">
        {c.stats.map((s) => (
          <div key={s.id} className="tier-row">
            <div className="tier-stat">
              <strong>{s.label}</strong>
              <span className="muted small">{s.description}</span>
            </div>
            <div className="tier-buttons">
              <button type="button" className="tier-btn" disabled={busy} onClick={() => set(s.id, (values[s.id] ?? 0) - 1)}>
                −
              </button>
              <span className="tier-value">{signed(values[s.id] ?? 0)}</span>
              <button type="button" className="tier-btn" disabled={busy} onClick={() => set(s.id, (values[s.id] ?? 0) + 1)}>
                +
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="newgame-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            answer(
              Object.entries(values)
                .filter(([, v]) => v !== 0)
                .map(([id, v]) => `${id} ${signed(v)}`)
                .join(", ") || `${c.stats[0]?.id ?? ""} 0`,
            )
          }
        >
          다음
        </button>
      </div>
    </>
  );
}

/** 트레잇 고르기: 약점·강점은 한 표(포인트 잔액), 성격은 따로 */
function TraitStep({ view, busy, answer }: StepProps) {
  const c = view.character!;
  const personality = view.step === "traits_personality";
  const [picked, setPicked] = useState<string[]>([]);
  const byId = useMemo(() => new Map(c.traits.map((t) => [t.id, t])), [c.traits]);
  const chosen = picked.map((id) => byId.get(id)!).filter(Boolean);
  const gained = chosen.filter((t) => t.kind === "negative").reduce((n, t) => n + t.cost, 0);
  const used = chosen.filter((t) => t.kind === "positive").reduce((n, t) => n + t.cost, 0);
  const lim = c.traitLimits;
  const countOf = (kind: string) => chosen.filter((t) => t.kind === kind).length;
  const limitOf = (kind: string) => (kind === "negative" ? lim?.max_negative : kind === "positive" ? lim?.max_positive : lim?.max_personality) ?? 99;
  const over = used > gained;
  const blockedBy = (t: (typeof c.traits)[number]) =>
    !picked.includes(t.id) && (countOf(t.kind) >= limitOf(t.kind) || t.opposites.some((o) => picked.includes(o)) || chosen.some((x) => x.opposites.includes(t.id)));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const groups: { kind: string; title: string }[] = personality
    ? [{ kind: "personality", title: "성격" }]
    : [
        { kind: "negative", title: "약점 (포인트를 얻는다)" },
        { kind: "positive", title: "강점 (포인트를 쓴다)" },
      ];
  return (
    <>
      <h2 className="newgame-title">{personality ? "성격" : "약점과 강점"}</h2>
      {!personality && (
        <p className={over ? "newgame-warn" : "newgame-note"}>
          약점으로 얻은 {gained} · 강점에 쓴 {used}
          {over ? " — 강점이 약점보다 많다" : ""} · 약점 {countOf("negative")}/{lim?.max_negative} · 강점 {countOf("positive")}/{lim?.max_positive}
        </p>
      )}
      {personality && <p className="newgame-note">포인트 없음 · {countOf("personality")}/{lim?.max_personality}개까지</p>}
      {groups.map((g) => {
        const list = c.traits.filter((t) => t.kind === g.kind);
        if (list.length === 0) return null;
        return (
          <div key={g.kind}>
            <h3 className="newgame-sub">{g.title}</h3>
            <div className="trait-list">
              {list.map((t) => {
                const on = picked.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`trait-card ${t.kind}${on ? " on" : ""}`}
                    disabled={busy || blockedBy(t)}
                    aria-pressed={on}
                    onClick={() => toggle(t.id)}
                  >
                    <span className="trait-head">
                      <strong>{t.label}</strong>
                      {t.kind !== "personality" && <span className="trait-cost">{t.kind === "negative" ? `+${t.cost}` : `-${t.cost}`}</span>}
                    </span>
                    <span className="choice-desc">{t.description}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="newgame-actions">
        <button type="button" className="primary" disabled={busy || over} onClick={() => answer(picked)}>
          {picked.length ? `${picked.length}개로 다음` : "고르지 않고 다음"}
        </button>
      </div>
    </>
  );
}

export function CreatedToast({ onClose }: { onClose: () => void }): ReactNode {
  useEffect(() => {
    const t = setTimeout(onClose, 12000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="created-toast" role="status">
      캐릭터를 만들었다. Claude 세션에서 첫 장면이 이어진다.
      <button type="button" aria-label="닫기" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
