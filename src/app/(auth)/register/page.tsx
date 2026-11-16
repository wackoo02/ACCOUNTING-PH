"use client";
import Link from "next/link";
import { useActionState } from "react";
import { register } from "../actions";
import { Errors } from "@/components/Errors";
import { Logo } from "@/components/Logo";

export default function RegisterPage() {
  const [state, action, pending] = useActionState(register, undefined);
  return (
    <div className="auth card">
      <Logo tagline />
      <h1 style={{ marginTop: 20 }}>Create your company</h1>
      <p className="muted">You will be the owner. A Philippine chart of accounts (PFRS/IFRS-aligned) is set up for you.</p>
      <Errors errors={state?.errors} />
      <form action={action}>
        <p><label>Company name</label><input name="company" required /></p>
        <p><label>TIN (optional)</label><input name="tin" placeholder="000-000-000-00000" /></p>
        <p><label>Your name</label><input name="name" required /></p>
        <p><label>Email</label><input name="email" type="email" required /></p>
        <p><label>Password (8+ characters)</label><input name="password" type="password" minLength={8} required /></p>
        <button disabled={pending}>{pending ? "Creating…" : "Create company"}</button>
      </form>
      <p className="muted">Already have an account? <Link href="/login">Sign in</Link></p>
    </div>
  );
}
