import { parseAnsweredSummary } from "../../lib/qSummary";

// "User has answered your questions: "q"="a", ... . You can now continue ..."
// appears as a synthetic text part after the question tool is answered —
// render it with the same card+chip language as the ask (q-view/q-card)
// instead of a raw mono dump. Pairs are extracted via the quoted "q"="a" shape.
export default function AnsweredSummary({ text }: { text: string }) {
  const pairs = parseAnsweredSummary(text);
  if (!pairs) return null;
  return (
    <div className="q-answered">
      <div className="q-answered-head mono">
        <i className="fa-solid fa-circle-check" />
        User answers
        <span className="q-answered-count">
          {pairs.length} {pairs.length === 1 ? "answer" : "answers"}
        </span>
      </div>
      <div className="q-view" style={{ padding: 0 }}>
        {pairs.map((p, i) => (
          <div key={i} className="q-card">
            <div className="q-text">{p.q}</div>
            <div className="q-opts">
              <span className="q-chip on">
                <i className="fa-solid fa-check" />
                {p.a}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="q-answered-foot mono">You can now continue with the user&apos;s answers in mind.</div>
    </div>
  );
}
