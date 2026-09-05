import { useEffect, useMemo, useRef, useState } from "react";
import type { QuestionAsk } from "../types";
import { useTranslation } from "../lib/i18n";
import "../styles/question.css";

type Props = {
  ask: QuestionAsk;
  onAnswer: (answers: string[][]) => void;
  onReject: () => void;
};

// floating ask card — rides the permission popup's shell for identical
// design/position. One compact section per question; click an option or
// ↑/↓ + Enter, Esc dismisses. Single-choice single-question forms answer
// straight from the option; anything else accumulates picks behind Answer.
// "Other…" is always offered for a typed custom answer.
export default function QuestionPopup({ ask, onAnswer, onReject }: Props) {
  const { t } = useTranslation();
  const qs = ask.questions;
  const instant = qs.length === 1 && !qs[0].multiple;

  const [picks, setPicks] = useState<Set<string>[]>(() => qs.map(() => new Set()));
  const [customs, setCustoms] = useState<string[]>(() => qs.map(() => ""));
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // scroll-under-cursor guard: programmatic scrollIntoView slides fresh rows
  // under a stationary pointer, whose stray mouseenter would yank the
  // highlight (e.g. onto the next question's first option). Only keyboard
  // nav scrolls, and hover updates pause while that scroll settles.
  const kbNav = useRef(false);
  const hoverLock = useRef(false);

  // flat keyboard-nav order: each question's options, then its Other row
  // (oi = -1 marks the custom input)
  const rows = useMemo(
    () => qs.flatMap((q, qi) => [...q.options.map((_, oi) => ({ qi, oi })), { qi, oi: -1 }]),
    [qs],
  );
  const complete = qs.every((_, qi) => picks[qi]?.size || customs[qi]?.trim());

  // custom text and option picks are mutually exclusive per question —
  // one answer each, never a checkbox plus a typed extra
  const choose = (qi: number, label: string) => {
    if (instant) return onAnswer([[label]]);
    setCustoms((prev) => prev.map((v, j) => (j === qi ? "" : v)));
    setPicks((prev) =>
      prev.map((s, i) => {
        if (i !== qi) return s;
        if (!qs[qi].multiple) return new Set([label]);
        const next = new Set(s);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return next;
      }),
    );
  };

  const typeCustom = (qi: number, text: string) => {
    if (text.trim()) setPicks((prev) => prev.map((s, j) => (j === qi ? new Set<string>() : s)));
    setCustoms((prev) => prev.map((v, j) => (j === qi ? text : v)));
  };

  const submitAll = () => {
    if (!complete) return;
    onAnswer(
      qs.map((_, qi) => [...(picks[qi] ?? []), ...(customs[qi]?.trim() ? [customs[qi].trim()] : [])]),
    );
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onReject();
        return;
      }
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        kbNav.current = true;
        setHi((h) =>
          Math.min(Math.max(h + (e.key === "ArrowDown" ? 1 : -1), 0), Math.max(rows.length - 1, 0)),
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (instant) {
          const r = rows[hi];
          if (!r) return;
          if (r.oi < 0) listRef.current?.querySelector<HTMLInputElement>(`input[data-q="${r.qi}"]`)?.focus();
          else choose(r.qi, qs[r.qi].options[r.oi].label);
        } else {
          submitAll();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  useEffect(() => {
    if (!kbNav.current) return;
    kbNav.current = false;
    hoverLock.current = true; // swallow the mouseenter storm mid-scroll
    listRef.current?.querySelector('[data-hl="true"]')?.scrollIntoView({ block: "nearest" });
    const timer = window.setTimeout(() => (hoverLock.current = false), 150);
    return () => clearTimeout(timer);
  }, [hi]);

  const hoverRow = (i: number) => {
    if (!hoverLock.current) setHi(i);
  };

  let idx = -1;

  return (
    <div className="permission-bar question-pop" role="dialog">
      <div className="title">{t("question.title")}</div>
      <div ref={listRef} className="q-body">
        {qs.map((q, qi) => (
          <div className="q-section" key={qi}>
            {qs.length > 1 && <div className="q-head">{q.header}</div>}
            <div className="what">{q.question}</div>
            {q.options.map((o) => {
              idx += 1;
              const i = idx;
              const sel = !!picks[qi]?.has(o.label);
              return (
                <button
                  type="button"
                  key={o.label}
                  className={`q-opt${sel ? " sel" : ""}${i === hi ? " hl" : ""}`}
                  data-hl={i === hi || undefined}
                  data-tip={o.description}
                  onMouseEnter={() => hoverRow(i)}
                  onClick={() => choose(qi, o.label)}
                >
                  <i
                    className={`fa-solid ${
                      sel ? "fa-circle-check" : q.multiple ? "fa-square" : "fa-circle"
                    }`}
                  />
                  <span>{o.label}</span>
                  {o.description && <small>{o.description}</small>}
                </button>
              );
            })}
            <div
              className={`q-custom${customs[qi]?.trim() ? " filled" : ""}${
                rows.findIndex((r) => r.qi === qi && r.oi === -1) === hi ? " hl" : ""
              }`}
              onMouseEnter={() => hoverRow(rows.findIndex((r) => r.qi === qi && r.oi === -1))}
              onClick={() =>
                listRef.current?.querySelector<HTMLInputElement>(`input[data-q="${qi}"]`)?.focus()
              }
            >
              <i className="fa-solid fa-pen" />
              <input
                data-q={qi}
                placeholder={t("question.other")}
                value={customs[qi]}
                onChange={(e) => typeCustom(qi, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitAll();
                  }
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="actions">
        {!instant && (
          <button className="allow" disabled={!complete} onClick={submitAll}>
            <i className="fa-solid fa-reply" />
            {t("question.answer")}
          </button>
        )}
        <button className="deny" onClick={onReject}>
          <i className="fa-solid fa-ban" />
          {t("question.dismiss")}
        </button>
        <div className="q-hint">{instant ? t("question.hint.instant") : t("question.hint.multi")}</div>
      </div>
    </div>
  );
}
