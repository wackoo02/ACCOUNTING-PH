import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import { invoicePdf, receiptPdf, statementPdf } from "@/lib/ar/pdf";

// GET /api/receivables/pdf?type=invoice&id=...         sales invoice or credit memo
// GET /api/receivables/pdf?type=receipt&id=...         collection receipt
// GET /api/receivables/pdf?type=statement&id=<customerId>&from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: Request) {
  const ctx = await requireCtx("reports.view");
  const u = new URL(req.url);
  const type = u.searchParams.get("type"), id = u.searchParams.get("id") ?? "";
  try {
    const pdf = type === "invoice" ? await invoicePdf(ctx.org.id, id)
      : type === "receipt" ? await receiptPdf(ctx.org.id, id)
      : type === "statement" ? await statementPdf(ctx.org.id, id, new Date(u.searchParams.get("from") ?? "1900-01-01"), new Date(u.searchParams.get("to") ?? new Date().toISOString().slice(0, 10)))
      : null;
    if (!pdf) return new NextResponse("Not found", { status: 404 });
    return new NextResponse(Buffer.from(pdf.bytes), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `${u.searchParams.get("download") ? "attachment" : "inline"}; filename="${pdf.fileName}"` },
    });
  } catch (e) {
    if (e instanceof LedgerError) return new NextResponse(e.errors.join("\n"), { status: 404 });
    throw e;
  }
}
