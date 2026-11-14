import { useEffect, useRef, useState } from "react";

/** 세계 설정 (packages/core GameState.options, statusServer의 /api/options 와 맞춘다) */
export type GameOptions = { mature: boolean; dialogue: "novel" | "script" };

type Row<K extends keyof GameOptions> = {
  key: K;
  label: string;
  help: string;
  choices: { value: GameOptions[K]; label: string }[];
};

const ROWS: [Row<"mature">, Row<"dialogue">] = [
  {
    key: "mature",
    label: "성인 콘텐츠",
    help: "성인 사이의 연애, 성적인 농담·괴롭힘·위협. 폭력과 죽음은 어느 쪽이든 나옵니다.",
    // 기본(끔)을 왼쪽에
    choices: [
      { value: false, label: "끔" },
      { value: true, label: "켬" },
    ],
  },
  {
    key: "dialogue",
    label: "대화 형식",
    help: "소설: 대사가 서술 속에 녹아 있습니다. 대본: 대사를 “이름: 대사” 줄로 따로 뗍니다.",
    choices: [
      { value: "novel", label: "소설" },
      { value: "script", label: "대본" },
    ],
  },
];

/**
 * 설정 버튼과 창 (12-63). 게임이 열려 있을 때만 바꿀 수 있다.
 * 바꾸면 다음 서술부터 GM이 따른다 (GM은 다음 장면 정보에서 바뀐 설정을 받는다)
 */
export function SettingsButton({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<GameOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** 창의 자리: 버튼 바로 아래, 오른쪽 끝을 버튼에 맞춘다 */
  const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const GUTTER = 8;
    const measure = () => {
      const b = buttonRef.current?.getBoundingClientRect();
      if (!b) return;
      const vw = document.documentElement.clientWidth;
      const width = Math.min(300, vw - GUTTER * 2);
      // 창의 오른쪽 끝을 톱니바퀴 버튼의 오른쪽 끝에 맞춘다 (왼쪽으로 넘치면 화면 안으로)
      const left = Math.max(b.right - width, GUTTER);
      setPlace({ top: b.bottom + 6, left, width });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void fetch("/api/options", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ open: boolean; options?: GameOptions }>)
      .then((b) => setOptions(b.open ? (b.options ?? null) : null))
      .catch(() => setError("설정을 읽지 못했습니다."));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => boxRef.current && !boxRef.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  const change = async (patch: Partial<GameOptions>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/options", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      const body = (await res.json()) as { options?: GameOptions; error?: string };
      if (!res.ok || !body.options) setError(body.error ?? "바꾸지 못했습니다.");
      else setOptions(body.options);
    } catch {
      setError("바꾸지 못했습니다 (연결 끊김).");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings" ref={boxRef}>
      <button
        ref={buttonRef}
        type="button"
        className={open ? "settings-button on" : "settings-button"}
        aria-label="설정"
        aria-expanded={open}
        title={enabled ? "설정" : "게임을 열면 설정을 바꿀 수 있습니다"}
        disabled={!enabled}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <div className="settings-panel" role="dialog" aria-label="설정" style={place ?? { visibility: "hidden" }}>
          <h2>설정</h2>
          {!options && !error && <p className="muted">불러오는 중…</p>}
          {options &&
            ROWS.map((row) => (
              <div key={row.key} className="settings-row">
                <div className="settings-label">{row.label}</div>
                <div className="settings-choices" role="radiogroup" aria-label={row.label}>
                  {row.choices.map((c) => (
                    <button
                      key={String(c.value)}
                      type="button"
                      role="radio"
                      aria-checked={options[row.key] === c.value}
                      className={options[row.key] === c.value ? "chip on" : "chip"}
                      disabled={saving}
                      onClick={() => options[row.key] !== c.value && void change({ [row.key]: c.value })}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="settings-help">{row.help}</p>
              </div>
            ))}
          {error && <p className="settings-error">{error}</p>}
          <p className="settings-note">바꾸면 다음 서술부터 적용됩니다.</p>
        </div>
      )}
    </div>
  );
}
