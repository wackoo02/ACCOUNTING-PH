"use client";
import { useActionState, type ReactNode } from "react";
import { Errors } from "./Errors";

type State = { errors?: string[]; message?: string } | undefined;

/** A form bound to a server action that shows its errors/success message inline. */
export function ActionForm({ action, children, className, style, confirm }: {
  action: (s: State, fd: FormData) => Promise<State>;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  confirm?: string;
}) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form action={run} className={className} style={style}
      onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      <Errors errors={state?.errors} />
      {state?.message && <div className="notice">{state.message}</div>}
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{children}</fieldset>
    </form>
  );
}
