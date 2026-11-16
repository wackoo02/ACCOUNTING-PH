"use client";
import Link from "next/link";
import { useActionState } from "react";
import { login } from "../actions";
import { Errors } from "@/components/Errors";
import { Logo } from "@/components/Logo";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <div className="auth card">
      <Logo tagline />
      <h1 style={{ marginTop: 20 }}>Sign in</h1>
      <Errors errors={state?.errors} />
      <form action={action}>
        <p><label>Email</label><input name="email" type="email" required autoFocus /></p>
        <p><label>Password</label><input name="password" type="password" required /></p>
        <button disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="muted">New company? <Link href="/register">Create an account</Link></p>
    </div>
  );
}
