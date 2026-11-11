import { NextResponse } from "next/server";
import { publicIds, readAgentKeys, readBoard, signingFlags } from "@/lib/nearRead";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const board = await readBoard();
    let agentKeys = [] as Awaited<ReturnType<typeof readAgentKeys>>;
    try {
      agentKeys = await readAgentKeys(publicIds.agentId);
    } catch {
      agentKeys = [];
    }
    return NextResponse.json({
      ...publicIds,
      ...signingFlags(),
      agentKeys,
      board,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The vault could not be read.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
