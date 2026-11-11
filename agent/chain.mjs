import { readFileSync } from "node:fs";
import { connect, keyStores, KeyPair } from "near-api-js";

function readPrivateKey(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed.private_key) {
    throw new Error(`No private_key field in ${path}`);
  }
  return parsed.private_key;
}

async function accountFromFile(env, accountId, credentialsFile) {
  if (!credentialsFile) {
    throw new Error(`Missing credentials file for ${accountId}`);
  }
  if (!String(accountId).endsWith(".testnet") || !String(env.NEAR_CONTRACT_ID).endsWith(".testnet")) {
    throw new Error("Agent CRS only signs for testnet account ids.");
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(readPrivateKey(credentialsFile));
  await keyStore.setKey(env.NEAR_NETWORK_ID, accountId, keyPair);
  const near = await connect({
    networkId: env.NEAR_NETWORK_ID,
    nodeUrl: env.NEAR_RPC_URL,
    keyStore,
  });
  return near.account(accountId);
}

function txHash(outcome) {
  return (
    outcome?.transaction?.hash ||
    outcome?.transaction_outcome?.id ||
    null
  );
}

function decodeSuccess(outcome) {
  const value = outcome?.status?.SuccessValue;
  if (!value) return null;
  const text = Buffer.from(value, "base64").toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function callAs(env, role, methodName, args, depositYocto) {
  const accountId = role === "agent" ? env.NEAR_AGENT_ACCOUNT_ID : env.NEAR_OWNER_ACCOUNT_ID;
  const credentialsFile =
    role === "agent" ? env.NEAR_AGENT_CREDENTIALS_FILE : env.NEAR_OWNER_CREDENTIALS_FILE;
  const account = await accountFromFile(env, accountId, credentialsFile);
  const outcome = await account.functionCall({
    contractId: env.NEAR_CONTRACT_ID,
    methodName,
    args,
    gas: 100_000_000_000_000n,
    attachedDeposit: BigInt(depositYocto),
  });
  return {
    signerId: accountId,
    transactionId: txHash(outcome),
    result: decodeSuccess(outcome),
    explorerUrl: txHash(outcome)
      ? `https://testnet.nearblocks.io/txns/${txHash(outcome)}`
      : null,
  };
}
