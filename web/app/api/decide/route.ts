import { NextResponse } from "next/server";
import { signingFlags } from "@/lib/nearRead";
import { runAgent } from "@/lib/runAgent";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!signingFlags().canDecide) {
    return NextResponse.json(
      {
        error:
          "This server has no owner key. Approval needs NEAR_OWNER_CREDENTIALS_FILE locally. The key is not in the repository.",
      },
      { status: 503 },
    );
  }
  const body = await request.json().catch(() => null);
  const action = body?.action;
  const id = Number(body?.id);
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "Choose approve or reject." }, { status: 400 });
  }
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Spend id must be a positive integer." }, { status: 400 });
  }
  try {
    const args =
      action === "approve" ? ["approve", String(id)] : ["reject", String(id), "Owner rejected the spend."];
    const result = await runAgent("decide.mjs", args);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The decision failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
