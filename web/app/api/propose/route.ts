import { NextResponse } from "next/server";
import { signingFlags } from "@/lib/nearRead";
import { runAgent } from "@/lib/runAgent";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!signingFlags().canPropose) {
    return NextResponse.json(
      {
        error:
          "This server has no agent key. The board can still be read. Add NEAR_AGENT_CREDENTIALS_FILE locally. The key is not in the repository.",
      },
      { status: 503 },
    );
  }
  const body = await request.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Write the spend in a sentence." }, { status: 400 });
  }
  if (text.length > 280) {
    return NextResponse.json({ error: "Keep the sentence to 280 characters." }, { status: 400 });
  }
  try {
    const result = await runAgent("propose.mjs", [text]);
    const status = result.ok === false ? 422 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The proposal failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
