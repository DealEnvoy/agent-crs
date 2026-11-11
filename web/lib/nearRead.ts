import { existsSync } from "node:fs";
import type { AgentKeySummary, BoardState } from "./types";

const CONTRACT_ID = process.env.NEAR_CONTRACT_ID || "vault.acrs261111k7m2.testnet";

const RPCS = [
  process.env.NEAR_RPC_URL,
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.near.org",
].filter((url, index, all): url is string => Boolean(url) && all.indexOf(url) === index);

async function rpc(method: string, params: unknown) {
  let lastError = "RPC did not respond";
  for (const url of RPCS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "agent-crs", method, params }),
        cache: "no-store",
      });
      if (!response.ok) {
        lastError = `RPC HTTP ${response.status}`;
        continue;
      }
      const payload = await response.json();
      if (payload.error) {
        lastError = payload.error.message || "RPC error";
        continue;
      }
      return payload.result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "RPC error";
    }
  }
  throw new Error(lastError);
}

export async function readBoard(): Promise<BoardState> {
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT_ID,
    method_name: "get_board",
    args_base64: Buffer.from(JSON.stringify({ audit_limit: 30 })).toString("base64"),
  });
  const text = Buffer.from(result.result).toString("utf8");
  return JSON.parse(text) as BoardState;
}

export async function readAgentKeys(agentId: string): Promise<AgentKeySummary[]> {
  const result = await rpc("query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: agentId,
  });
  const keys = Array.isArray(result.keys) ? result.keys : [];
  return keys.map((entry: { access_key?: { permission?: unknown } }) => {
    const permission = entry.access_key?.permission;
    if (permission === "FullAccess") return { kind: "full_access" as const };
    if (permission && typeof permission === "object" && "FunctionCall" in permission) {
      const call = (permission as { FunctionCall: { receiver_id?: string; method_names?: string[] } })
        .FunctionCall;
      return {
        kind: "function_call" as const,
        receiverId: call.receiver_id,
        methods: call.method_names ?? [],
      };
    }
    return { kind: "unknown" as const };
  });
}

export function signingFlags() {
  const agentFile = process.env.NEAR_AGENT_CREDENTIALS_FILE;
  const ownerFile = process.env.NEAR_OWNER_CREDENTIALS_FILE;
  return {
    canPropose: Boolean(agentFile && existsSync(agentFile)),
    canDecide: Boolean(ownerFile && existsSync(ownerFile)),
  };
}

export const publicIds = {
  contractId: CONTRACT_ID,
  ownerId: process.env.NEAR_OWNER_ACCOUNT_ID || "acrs261111k7m2.testnet",
  agentId: process.env.NEAR_AGENT_ACCOUNT_ID || "agent.acrs261111k7m2.testnet",
  vendorId: process.env.NEAR_VENDOR_ACCOUNT_ID || "vendor.acrs261111k7m2.testnet",
  otherId: process.env.NEAR_OTHER_ACCOUNT_ID || "other.acrs261111k7m2.testnet",
  explorerUrl: `https://testnet.nearblocks.io/address/${CONTRACT_ID}`,
};
