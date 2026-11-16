"use client";
import { useActionState } from "react";
import { addUser } from "../actions";
import { Errors } from "@/components/Errors";

export function AddUserForm() {
  const [s, a, p] = useActionState(addUser, undefined);
  return (
    <form action={a} className="card">
      <Errors errors={s?.errors} />
      {s?.message && <div className="notice">{s.message}</div>}
      <div className="row">
        <div><label>Name</label><input name="name" required /></div>
        <div><label>Email</label><input name="email" type="email" required /></div>
        <div><label>Role</label><select name="role" defaultValue="BOOKKEEPER"><option value="ADMIN">Administrator</option><option value="ACCOUNTANT">Accountant</option><option value="BOOKKEEPER">Bookkeeper</option><option value="VIEWER">Viewer</option></select></div>
        <div><label>Temporary password</label><input name="password" type="text" minLength={8} required /></div>
        <div style={{ flex: 0 }}><button disabled={p}>Add</button></div>
      </div>
    </form>
  );
}

