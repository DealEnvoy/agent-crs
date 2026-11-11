import { loadEnv, publicConfig } from "./env.mjs";
import { callAs } from "./chain.mjs";

const [action, idRaw, ...reasonParts] = process.argv.slice(2);
if (!action || !idRaw || !["approve", "reject"].includes(action)) {
  console.error("Usage: node agent/decide.mjs approve <id>");
  console.error("       node agent/decide.mjs reject <id> \"reason\"");
  process.exit(1);
}

const env = loadEnv();
const config = publicConfig();
env.NEAR_CONTRACT_ID = config.contractId;
env.NEAR_OWNER_ACCOUNT_ID = config.ownerId;

const id = Number(idRaw);
if (!Number.isInteger(id) || id < 1) {
  throw new Error("Spend id must be a positive integer.");
}

const submitted =
  action === "approve"
    ? await callAs(env, "owner", "approve_spend", { id }, "1")
    : await callAs(
        env,
        "owner",
        "reject_spend",
        { id, reason: reasonParts.join(" ").trim() },
        "1",
      );

console.log(
  JSON.stringify(
    {
      ok: true,
      action,
      signerId: submitted.signerId,
      decision: submitted.result,
      transactionId: submitted.transactionId,
      explorerUrl: submitted.explorerUrl,
      note: "Signed with the owner full access key and 1 yoctoNEAR.",
    },
    null,
    2,
  ),
);
