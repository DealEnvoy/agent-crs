export type NearAmount = string;

export interface PendingSpend {
  id: number;
  receiver_id: string;
  amount: NearAmount;
  memo: string;
  reason: string;
  requested_by: string;
  requested_at_ns: number;
}

export interface AuditEntry {
  seq: number;
  ts_ns: number;
  action: string;
  actor: string;
  receiver_id: string | null;
  amount: NearAmount | null;
  spend_id: number | null;
  reason: string;
  memo: string;
}

export interface PolicyView {
  owner: string;
  agent: string;
  paused: boolean;
  allowlist: string[];
  max_per_tx: NearAmount;
  max_per_day: NearAmount;
  daily_spent: NearAmount;
  window_start_ns: number;
  window_end_ns: number;
  vault_balance: NearAmount;
  available_balance: NearAmount;
  pending_count: number;
  audit_count: number;
}

export interface BoardState {
  policy: PolicyView;
  pending: PendingSpend[];
  audit: AuditEntry[];
}

export interface AgentKeySummary {
  kind: "function_call" | "full_access" | "unknown";
  receiverId?: string;
  methods?: string[];
}

export interface BoardResponse {
  contractId: string;
  ownerId: string;
  agentId: string;
  vendorId: string;
  otherId: string;
  explorerUrl: string;
  canPropose: boolean;
  canDecide: boolean;
  agentKeys: AgentKeySummary[];
  board: BoardState;
}
