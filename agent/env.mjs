import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

export function loadEnv() {
  loadEnvFile(resolve(root, "web/.env.local"));
  loadEnvFile(resolve(root, "web/.env"));
  loadEnvFile(resolve(root, ".env"));
  const network = process.env.NEAR_NETWORK_ID || "testnet";
  if (network !== "testnet") {
    throw new Error("Agent CRS refuses to run on any network other than testnet.");
  }
  process.env.NEAR_NETWORK_ID = network;
  if (!process.env.NEAR_RPC_URL) {
    process.env.NEAR_RPC_URL = "https://test.rpc.fastnear.com";
  }
  return process.env;
}

export function publicConfig() {
  return {
    network: "testnet",
    rpcUrl: process.env.NEAR_RPC_URL,
    contractId: process.env.NEAR_CONTRACT_ID || "vault.acrs261111k7m2.testnet",
    ownerId: process.env.NEAR_OWNER_ACCOUNT_ID || "acrs261111k7m2.testnet",
    agentId: process.env.NEAR_AGENT_ACCOUNT_ID || "agent.acrs261111k7m2.testnet",
    vendorId: process.env.NEAR_VENDOR_ACCOUNT_ID || "vendor.acrs261111k7m2.testnet",
    otherId: process.env.NEAR_OTHER_ACCOUNT_ID || "other.acrs261111k7m2.testnet",
  };
}

export function aliasesFromEnv() {
  const config = publicConfig();
  return [
    { alias: "vendor", accountId: config.vendorId },
    { alias: "other", accountId: config.otherId },
  ];
}
