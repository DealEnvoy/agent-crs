import { loadEnv, publicConfig } from "./env.mjs";
import { getBoard } from "./rpc.mjs";

const env = loadEnv();
const config = publicConfig();
env.NEAR_CONTRACT_ID = config.contractId;
const board = await getBoard(env);
console.log(JSON.stringify(board, null, 2));
