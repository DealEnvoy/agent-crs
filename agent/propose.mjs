import { aliasesFromEnv, loadEnv, publicConfig } from "./env.mjs";
import { interpretSpend } from "./parse.mjs";
import { callAs } from "./chain.mjs";

const text = process.argv.slice(2).join(" ").trim();
if (!text) {
  console.error("Usage: node agent/propose.mjs \"Pay 0.05 NEAR to vendor for API credits\"");
  process.exit(1);
}

const env = loadEnv();
const config = publicConfig();
env.NEAR_CONTRACT_ID = config.contractId;
env.NEAR_AGENT_ACCOUNT_ID = config.agentId;
env.NEAR_VENDOR_ACCOUNT_ID = config.vendorId;
env.NEAR_OTHER_ACCOUNT_ID = config.otherId;

const interpreted = await interpretSpend(text, aliasesFromEnv());
if (!interpreted.ok) {
  console.log(JSON.stringify({ ok: false, ...interpreted }, null, 2));
  process.exit(2);
}

const submitted = await callAs(
  env,
  "agent",
  "request_spend",
  {
    receiver_id: interpreted.receiverId,
    amount: interpreted.amountYocto,
    memo: interpreted.memo,
  },
  "0",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      interpreter: interpreted.interpreter,
      model: interpreted.model,
      note: interpreted.note,
      receiverId: interpreted.receiverId,
      amountYocto: interpreted.amountYocto,
      amountNear: interpreted.amountNear,
      memo: interpreted.memo,
      decision: submitted.result,
      transactionId: submitted.transactionId,
      explorerUrl: submitted.explorerUrl,
      signerId: submitted.signerId,
    },
    null,
    2,
  ),
);
