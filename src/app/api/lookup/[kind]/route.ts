import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { MASTERS, isMasterKind } from "@/lib/masters/config";
import { loadCandidates } from "@/lib/masters/candidates";
import { findSimilar, nextCode, prefillFromText } from "@/lib/masters/similar";

// GET /api/lookup/<kind>?q=<typed text>[&tin=&email=&accountNumber=&code=&type=]
// Used when someone chooses "Add new" in a picker, or saves a new master record:
// returns records that look like the same thing so they can review before creating a duplicate.
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!isMasterKind(kind)) return NextResponse.json({ error: "Unknown list" }, { status: 404 });
  const ctx = await requireCtx();
  const u = new URL(req.url).searchParams;
  const q = (u.get("q") ?? "").slice(0, 200);
  const type = u.get("type") ?? undefined;
  const { candidates, codes } = await loadCandidates(kind, ctx.org.id, kind === "dimensions" ? type : undefined);
  const matches = findSimilar(
    { name: q, code: u.get("code") ?? undefined, tin: u.get("tin") ?? undefined, email: u.get("email") ?? undefined, accountNumber: u.get("accountNumber") ?? undefined },
    candidates.filter((c) => c.code !== u.get("exclude")),
  );
  return NextResponse.json({
    canAdd: can(ctx.role, "masters.manage"),
    singular: MASTERS[kind].singular,
    matches,
    nextCode: kind === "accounts" || kind === "currencies" ? null : nextCode(codes),
    prefill: prefillFromText(kind, q),
  });
}
