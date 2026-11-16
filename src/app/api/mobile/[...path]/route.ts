import { handleMobile } from "@/lib/api/mobile";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // receipt reading can take a few seconds

type Ctx = { params: Promise<{ path: string[] }> };
const handle = async (req: Request, { params }: Ctx) => handleMobile(req, (await params).path.join("/"));

export { handle as GET, handle as POST, handle as PUT };
