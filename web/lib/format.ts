export function formatNear(yocto: string | number | null | undefined): string {
  if (yocto == null || yocto === "") return "0";
  const value = BigInt(yocto);
  const scale = 10n ** 24n;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${text}` : text;
}

export function formatTime(ns: string | number): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  const formatted = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(ms));
  return `${formatted} UTC`;
}

const REASONS: Record<string, string> = {
  in_policy: "Inside policy",
  over_per_tx: "Over the per transaction cap",
  over_daily: "Over the daily cap",
  not_allowlisted: "Receiver is not on the allowlist",
  paused: "Vault is paused",
  zero_amount: "Amount is zero",
  insufficient_balance: "Vault balance is too low",
  queue_full: "The queue is full",
  receiver_is_vault: "The vault cannot pay itself",
  owner_approved: "Owner approved",
  owner_rejected: "Owner rejected",
  transfer_ok: "Transfer confirmed",
  transfer_failed: "Transfer failed",
  transfer_scheduled: "Transfer scheduled",
  agent_requested: "Agent requested",
  owner_set_policy: "Owner set the policy",
  owner_paused: "Owner paused the vault",
  owner_unpaused: "Owner opened the vault",
  deposit: "Deposit",
};

const ACTIONS: Record<string, string> = {
  proposal: "Proposal",
  queued: "Queued",
  denied: "Denied",
  released: "Released",
  executed: "Executed",
  execution_failed: "Execution failed",
  approved: "Approved",
  rejected: "Rejected",
  policy_set: "Policy set",
  paused: "Paused",
  unpaused: "Opened",
  funded: "Funded",
  agent_set: "Agent set",
};

export function reasonLabel(reason: string): string {
  return REASONS[reason] ?? reason;
}

export function actionLabel(action: string): string {
  return ACTIONS[action] ?? action;
}
