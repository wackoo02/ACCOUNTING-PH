import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { askAssistant } from "@/lib/assistant";

// POST /api/assistant { question, history? } -> { answer, links, source }
export async function POST(req: Request) {
  const ctx = await requireCtx("reports.view");
  const body = (await req.json().catch(() => ({}))) as { question?: unknown; history?: unknown };
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Ask a question" }, { status: 400 });
  const history = Array.isArray(body.history)
    ? body.history.filter((m): m is { role: "user" | "assistant"; content: string } => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    : [];
  return NextResponse.json(await askAssistant(ctx.org.id, ctx.role, question, history));
}
