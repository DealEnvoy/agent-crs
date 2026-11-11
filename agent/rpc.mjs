export async function viewCall(rpcUrl, contractId, methodName, args) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "agent-crs",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args ?? {})).toString("base64"),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message || payload.error.data || "RPC error");
  }
  const bytes = Buffer.from(payload.result.result);
  return JSON.parse(bytes.toString("utf8"));
}

export async function getBoard(env) {
  return viewCall(env.NEAR_RPC_URL, env.NEAR_CONTRACT_ID, "get_board", {
    audit_limit: 30,
  });
}
