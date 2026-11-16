"use client";
import type { CSSProperties } from "react";
import type { SimilarMatch } from "@/lib/masters/similar";

/** Small "this may already exist" box shown before a new master record is created. */
export function SimilarPopup(props: {
  singular: string;
  text: string;
  matches: SimilarMatch[];
  canAdd: boolean;
  style?: CSSProperties;
  canUse?: (m: SimilarMatch) => boolean;
  onUse?: (m: SimilarMatch) => void;
  onReview: (m: SimilarMatch) => void;
  onSkip: () => void;
  onCancel: () => void;
  skipLabel?: string;
}) {
  const { singular, text, matches, canAdd } = props;
  const thing = singular.toLowerCase();
  return (
    <div className="similar-pop" role="dialog" aria-label="Similar records found" style={props.style}>
      <div className="similar-head">
        <span className="similar-dot" aria-hidden="true">!</span>
        <div>
          <strong>{matches.length ? `This ${thing} may already exist` : `Add a new ${thing}`}</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            {matches.length
              ? <>We found {matches.length === 1 ? "a record that looks" : `${matches.length} records that look`} like &ldquo;{text}&rdquo;. Review before you add a new one.</>
              : <>Only an owner or admin can add master records.</>}
          </div>
        </div>
      </div>
      {matches.length > 0 && (
        <ul className="similar-list">
          {matches.map((m) => (
            <li key={m.id}>
              <div style={{ minWidth: 0 }}>
                <div className="similar-name">{m.code} · {m.label}</div>
                <div className="muted" style={{ fontSize: 11 }}>{m.reason} · {Math.round(m.score * 100)}% match</div>
              </div>
              <div className="similar-acts">
                {props.onUse && (!props.canUse || props.canUse(m)) && <button type="button" onClick={() => props.onUse!(m)}>Use this</button>}
                <button type="button" className="secondary" onClick={() => props.onReview(m)}>Review</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="similar-foot">
        <button type="button" className="link" onClick={props.onCancel}>Cancel</button>
        {canAdd
          ? <button type="button" className="secondary" onClick={props.onSkip}>{props.skipLabel ?? `Skip & create new ${thing}`}</button>
          : <span className="muted" style={{ fontSize: 12 }}>Ask an owner or admin to add &ldquo;{text}&rdquo;.</span>}
      </div>
    </div>
  );
}
