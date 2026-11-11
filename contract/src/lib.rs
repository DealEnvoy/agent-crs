//! Agent CRS vault.
//!
//! The account that runs this contract holds the NEAR. An agent may only call
//! `request_spend`, and only with a function call key that cannot attach a
//! deposit. The contract releases a transfer when the receiver is allowlisted
//! and the amount fits the per transaction cap and the daily cap. Every other
//! spend is queued for the owner, or denied. Owner methods require one
//! yoctoNEAR, which a function call key cannot attach.

use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault,     Promise,
};

const DAY_NS: u64 = 86_400 * 1_000_000_000;
const MAX_AUDIT: usize = 200;
const MAX_PENDING: usize = 20;
const MAX_ALLOWLIST: usize = 32;
const MAX_MEMO: usize = 280;
/// Kept back so storage growth cannot brick the account. 0.1 NEAR.
const RESERVE_YOCTO: u128 = 100_000_000_000_000_000_000_000;
const CALLBACK_GAS: Gas = Gas::from_tgas(30);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingSpend {
    pub id: u64,
    pub receiver_id: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub reason: String,
    pub requested_by: AccountId,
    pub requested_at_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEntry {
    pub seq: u64,
    pub ts_ns: u64,
    pub action: String,
    pub actor: AccountId,
    pub receiver_id: Option<AccountId>,
    pub amount: Option<NearToken>,
    pub spend_id: Option<u64>,
    pub reason: String,
    pub memo: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendResult {
    pub decision: String,
    pub spend_id: Option<u64>,
    pub reason: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PolicyView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub paused: bool,
    pub allowlist: Vec<AccountId>,
    pub max_per_tx: NearToken,
    pub max_per_day: NearToken,
    pub daily_spent: NearToken,
    pub window_start_ns: u64,
    pub window_end_ns: u64,
    pub vault_balance: NearToken,
    pub available_balance: NearToken,
    pub pending_count: u32,
    pub audit_count: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BoardView {
    pub policy: PolicyView,
    pub pending: Vec<PendingSpend>,
    pub audit: Vec<AuditEntry>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    agent: AccountId,
    paused: bool,
    allowlist: Vec<AccountId>,
    max_per_tx: NearToken,
    max_per_day: NearToken,
    window_started: bool,
    window_start_ns: u64,
    daily_spent: NearToken,
    next_id: u64,
    audit_seq: u64,
    pending: Vec<PendingSpend>,
    audit: Vec<AuditEntry>,
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId) -> Self {
        require!(
            owner != agent,
            "owner and agent must be different accounts"
        );
        require!(
            owner != env::current_account_id(),
            "owner must not be the vault account"
        );
        require!(
            agent != env::current_account_id(),
            "agent must not be the vault account"
        );
        Self {
            owner,
            agent,
            paused: false,
            allowlist: Vec::new(),
            max_per_tx: NearToken::from_yoctonear(0),
            max_per_day: NearToken::from_yoctonear(0),
            window_started: false,
            window_start_ns: 0,
            daily_spent: NearToken::from_yoctonear(0),
            next_id: 1,
            audit_seq: 0,
            pending: Vec::new(),
            audit: Vec::new(),
        }
    }

    #[payable]
    pub fn set_policy(
        &mut self,
        allowlist: Vec<AccountId>,
        max_per_tx: NearToken,
        max_per_day: NearToken,
    ) {
        near_sdk::assert_one_yocto();
        self.assert_owner();
        require!(
            max_per_tx <= max_per_day,
            "per transaction cap cannot exceed the daily cap"
        );
        require!(
            allowlist.len() <= MAX_ALLOWLIST,
            "allowlist can hold at most 32 receivers"
        );
        let mut clean = Vec::with_capacity(allowlist.len());
        for id in allowlist {
            require!(
                id != env::current_account_id(),
                "vault cannot be on the allowlist"
            );
            require!(
                !clean.contains(&id),
                "duplicate receiver in allowlist"
            );
            clean.push(id);
        }
        self.allowlist = clean;
        self.max_per_tx = max_per_tx;
        self.max_per_day = max_per_day;
        self.push_audit(
            "policy_set",
            env::predecessor_account_id(),
            None,
            Some(max_per_tx),
            None,
            "owner_set_policy",
            "",
        );
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        near_sdk::assert_one_yocto();
        self.assert_owner();
        self.paused = paused;
        self.push_audit(
            if paused { "paused" } else { "unpaused" },
            env::predecessor_account_id(),
            None,
            None,
            None,
            if paused { "owner_paused" } else { "owner_unpaused" },
            "",
        );
    }

    #[payable]
    pub fn set_agent(&mut self, agent: AccountId) {
        near_sdk::assert_one_yocto();
        self.assert_owner();
        require!(
            agent != self.owner,
            "owner and agent must be different accounts"
        );
        require!(
            agent != env::current_account_id(),
            "agent must not be the vault account"
        );
        self.agent = agent.clone();
        self.push_audit(
            "agent_set",
            env::predecessor_account_id(),
            Some(agent),
            None,
            None,
            "owner_set_agent",
            "",
        );
    }

    /// Accept a top up. The attached deposit stays in the vault account.
    #[payable]
    pub fn fund(&mut self) {
        let amount = env::attached_deposit();
        require!(
            amount > NearToken::from_yoctonear(0),
            "attach NEAR to fund the vault"
        );
        self.push_audit(
            "funded",
            env::predecessor_account_id(),
            None,
            Some(amount),
            None,
            "deposit",
            "",
        );
    }

    /// Agent entry point. Attach no deposit. A function call key can sign this
    /// and cannot sign the owner methods.
    pub fn request_spend(
        &mut self,
        receiver_id: AccountId,
        amount: NearToken,
        memo: String,
    ) -> SpendResult {
        require!(
            env::predecessor_account_id() == self.agent,
            "only the agent can request a spend"
        );
        let memo = clean_memo(memo);
        self.roll_window();
        self.push_audit(
            "proposal",
            env::predecessor_account_id(),
            Some(receiver_id.clone()),
            Some(amount),
            None,
            "agent_requested",
            &memo,
        );
        let (decision, reason) = self.classify(&receiver_id, amount);
        match decision.as_str() {
            "denied" => {
                self.push_audit(
                    "denied",
                    env::predecessor_account_id(),
                    Some(receiver_id),
                    Some(amount),
                    None,
                    &reason,
                    &memo,
                );
                SpendResult {
                    decision,
                    spend_id: None,
                    reason,
                }
            }
            "queued" => {
                if self.pending.len() >= MAX_PENDING {
                    self.push_audit(
                        "denied",
                        env::predecessor_account_id(),
                        Some(receiver_id),
                        Some(amount),
                        None,
                        "queue_full",
                        &memo,
                    );
                    return SpendResult {
                        decision: "denied".to_string(),
                        spend_id: None,
                        reason: "queue_full".to_string(),
                    };
                }
                let id = self.alloc_id();
                self.pending.push(PendingSpend {
                    id,
                    receiver_id: receiver_id.clone(),
                    amount,
                    memo: memo.clone(),
                    reason: reason.clone(),
                    requested_by: env::predecessor_account_id(),
                    requested_at_ns: env::block_timestamp(),
                });
                self.push_audit(
                    "queued",
                    env::predecessor_account_id(),
                    Some(receiver_id),
                    Some(amount),
                    Some(id),
                    &reason,
                    &memo,
                );
                SpendResult {
                    decision,
                    spend_id: Some(id),
                    reason,
                }
            }
            _ => {
                let id = self.alloc_id();
                self.release(id, receiver_id, amount, &memo, "in_policy");
                SpendResult {
                    decision: "released".to_string(),
                    spend_id: Some(id),
                    reason: "in_policy".to_string(),
                }
            }
        }
    }

    /// Owner override. Requires one yoctoNEAR so a function call key cannot approve.
    #[payable]
    pub fn approve_spend(&mut self, id: u64) -> SpendResult {
        near_sdk::assert_one_yocto();
        self.assert_owner();
        let index = self
            .pending
            .iter()
            .position(|spend| spend.id == id)
            .unwrap_or_else(|| env::panic_str("unknown spend"));
        self.roll_window();
        if self.paused {
            let spend = self.pending[index].clone();
            self.push_audit(
                "denied",
                env::predecessor_account_id(),
                Some(spend.receiver_id),
                Some(spend.amount),
                Some(id),
                "paused",
                &spend.memo,
            );
            return SpendResult {
                decision: "denied".to_string(),
                spend_id: Some(id),
                reason: "paused".to_string(),
            };
        }
        let spend = self.pending[index].clone();
        if spend.amount > self.available() {
            self.push_audit(
                "denied",
                env::predecessor_account_id(),
                Some(spend.receiver_id),
                Some(spend.amount),
                Some(id),
                "insufficient_balance",
                &spend.memo,
            );
            return SpendResult {
                decision: "denied".to_string(),
                spend_id: Some(id),
                reason: "insufficient_balance".to_string(),
            };
        }
        self.pending.remove(index);
        self.push_audit(
            "approved",
            env::predecessor_account_id(),
            Some(spend.receiver_id.clone()),
            Some(spend.amount),
            Some(id),
            "owner_approved",
            &spend.memo,
        );
        self.release(
            id,
            spend.receiver_id,
            spend.amount,
            &spend.memo,
            "owner_approved",
        );
        SpendResult {
            decision: "released".to_string(),
            spend_id: Some(id),
            reason: "owner_approved".to_string(),
        }
    }

    #[payable]
    pub fn reject_spend(&mut self, id: u64, reason: String) -> SpendResult {
        near_sdk::assert_one_yocto();
        self.assert_owner();
        let reason = {
            let trimmed = reason.trim();
            if trimmed.is_empty() {
                "owner_rejected".to_string()
            } else {
                clean_memo(trimmed.to_string())
            }
        };
        let index = self
            .pending
            .iter()
            .position(|spend| spend.id == id)
            .unwrap_or_else(|| env::panic_str("unknown spend"));
        let spend = self.pending.remove(index);
        self.push_audit(
            "rejected",
            env::predecessor_account_id(),
            Some(spend.receiver_id),
            Some(spend.amount),
            Some(id),
            &reason,
            &spend.memo,
        );
        SpendResult {
            decision: "rejected".to_string(),
            spend_id: Some(id),
            reason,
        }
    }

    /// Contract callback after the transfer receipt. Not callable by the agent key.
    #[private]
    pub fn on_transfer(
        &mut self,
        spend_id: u64,
        amount: NearToken,
        window_start_ns: u64,
        receiver_id: AccountId,
    ) {
        // The generated wrapper also checks this. The explicit check keeps the
        // unit test on the same path a direct call would take.
        near_sdk::assert_self();
        let ok = env::promise_result_checked(0, 1024).is_ok();
        if ok {
            self.push_audit(
                "executed",
                env::current_account_id(),
                Some(receiver_id),
                Some(amount),
                Some(spend_id),
                "transfer_ok",
                "",
            );
            return;
        }
        if self.window_started && self.window_start_ns == window_start_ns {
            self.daily_spent = saturating_token_sub(self.daily_spent, amount);
        }
        self.push_audit(
            "execution_failed",
            env::current_account_id(),
            Some(receiver_id),
            Some(amount),
            Some(spend_id),
            "transfer_failed",
            "",
        );
    }

    pub fn get_policy(&self) -> PolicyView {
        self.policy_view()
    }

    pub fn get_pending(&self) -> Vec<PendingSpend> {
        self.pending.clone()
    }

    pub fn get_audit(&self, limit: u32) -> Vec<AuditEntry> {
        self.recent_audit(limit)
    }

    pub fn get_daily_spent(&self) -> NearToken {
        self.effective_daily_spent()
    }

    pub fn get_board(&self, audit_limit: u32) -> BoardView {
        BoardView {
            policy: self.policy_view(),
            pending: self.pending.clone(),
            audit: self.recent_audit(audit_limit),
        }
    }
}

impl Vault {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can do that"
        );
    }

    fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn roll_window(&mut self) {
        let now = env::block_timestamp();
        let elapsed = now.saturating_sub(self.window_start_ns);
        if !self.window_started || elapsed >= DAY_NS {
            self.window_started = true;
            self.window_start_ns = now;
            self.daily_spent = NearToken::from_yoctonear(0);
        }
    }

    fn effective_daily_spent(&self) -> NearToken {
        let now = env::block_timestamp();
        if !self.window_started || now.saturating_sub(self.window_start_ns) >= DAY_NS {
            NearToken::from_yoctonear(0)
        } else {
            self.daily_spent
        }
    }

    fn available(&self) -> NearToken {
        let balance = env::account_balance().as_yoctonear();
        let storage = env::storage_byte_cost().as_yoctonear()
            * u128::from(env::storage_usage());
        let reserved = storage.saturating_add(RESERVE_YOCTO);
        NearToken::from_yoctonear(balance.saturating_sub(reserved))
    }

    fn classify(&self, receiver_id: &AccountId, amount: NearToken) -> (String, String) {
        if amount.is_zero() {
            return ("denied".to_string(), "zero_amount".to_string());
        }
        if receiver_id == &env::current_account_id() {
            return ("denied".to_string(), "receiver_is_vault".to_string());
        }
        if self.paused {
            return ("denied".to_string(), "paused".to_string());
        }
        if !self.allowlist.iter().any(|id| id == receiver_id) {
            return ("queued".to_string(), "not_allowlisted".to_string());
        }
        if amount > self.max_per_tx {
            return ("queued".to_string(), "over_per_tx".to_string());
        }
        let next_daily = self.daily_spent.as_yoctonear().saturating_add(amount.as_yoctonear());
        if next_daily > self.max_per_day.as_yoctonear() {
            return ("queued".to_string(), "over_daily".to_string());
        }
        if amount > self.available() {
            return ("queued".to_string(), "insufficient_balance".to_string());
        }
        ("released".to_string(), "in_policy".to_string())
    }

    fn release(
        &mut self,
        spend_id: u64,
        receiver_id: AccountId,
        amount: NearToken,
        memo: &str,
        reason: &str,
    ) {
        self.daily_spent = NearToken::from_yoctonear(
            self.daily_spent
                .as_yoctonear()
                .checked_add(amount.as_yoctonear())
                .unwrap_or_else(|| env::panic_str("daily spent overflow")),
        );
        let window = self.window_start_ns;
        self.push_audit(
            "released",
            env::predecessor_account_id(),
            Some(receiver_id.clone()),
            Some(amount),
            Some(spend_id),
            reason,
            memo,
        );
        Promise::new(receiver_id.clone())
            .transfer(amount)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer(spend_id, amount, window, receiver_id),
            )
            .detach();
    }

    fn push_audit(
        &mut self,
        action: &str,
        actor: AccountId,
        receiver_id: Option<AccountId>,
        amount: Option<NearToken>,
        spend_id: Option<u64>,
        reason: &str,
        memo: &str,
    ) {
        self.audit_seq += 1;
        let entry = AuditEntry {
            seq: self.audit_seq,
            ts_ns: env::block_timestamp(),
            action: action.to_string(),
            actor,
            receiver_id,
            amount,
            spend_id,
            reason: reason.to_string(),
            memo: memo.to_string(),
        };
        let event = near_sdk::serde_json::json!({
            "standard": "agent-crs",
            "version": "1.0.0",
            "event": action,
            "data": {
                "seq": entry.seq,
                "reason": reason,
                "spend_id": spend_id,
            }
        });
        env::log_str(&format!("EVENT_JSON:{event}"));
        self.audit.push(entry);
        if self.audit.len() > MAX_AUDIT {
            let overflow = self.audit.len() - MAX_AUDIT;
            self.audit.drain(0..overflow);
        }
    }

    fn policy_view(&self) -> PolicyView {
        let start = if self.window_started {
            self.window_start_ns
        } else {
            env::block_timestamp()
        };
        PolicyView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            paused: self.paused,
            allowlist: self.allowlist.clone(),
            max_per_tx: self.max_per_tx,
            max_per_day: self.max_per_day,
            daily_spent: self.effective_daily_spent(),
            window_start_ns: start,
            window_end_ns: start.saturating_add(DAY_NS),
            vault_balance: env::account_balance(),
            available_balance: self.available(),
            pending_count: self.pending.len() as u32,
            audit_count: self.audit.len() as u32,
        }
    }

    fn recent_audit(&self, limit: u32) -> Vec<AuditEntry> {
        let limit = (limit as usize).clamp(0, 50);
        let len = self.audit.len();
        let start = len.saturating_sub(limit);
        self.audit[start..].iter().rev().cloned().collect()
    }
}

fn clean_memo(memo: String) -> String {
    let trimmed = memo.trim();
    require!(
        trimmed.len() <= MAX_MEMO,
        "memo must be 280 characters or fewer"
    );
    trimmed.to_string()
}

fn saturating_token_sub(left: NearToken, right: NearToken) -> NearToken {
    NearToken::from_yoctonear(left.as_yoctonear().saturating_sub(right.as_yoctonear()))
}

#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_transfer(
        &mut self,
        spend_id: u64,
        amount: NearToken,
        window_start_ns: u64,
        receiver_id: AccountId,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn owner() -> AccountId {
        "owner.test.near".parse().unwrap()
    }
    fn agent() -> AccountId {
        "agent.owner.test.near".parse().unwrap()
    }
    fn vendor() -> AccountId {
        "vendor.owner.test.near".parse().unwrap()
    }
    fn other() -> AccountId {
        "other.owner.test.near".parse().unwrap()
    }
    fn vault() -> AccountId {
        "vault.owner.test.near".parse().unwrap()
    }

    fn context(
        predecessor: AccountId,
        deposit_yocto: u128,
        timestamp: u64,
        balance_near: u128,
    ) -> near_sdk::VMContext {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(vault())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
            .account_balance(NearToken::from_near(balance_near))
            .block_timestamp(timestamp)
            .prepaid_gas(Gas::from_tgas(300));
        builder.build()
    }

    fn use_context(predecessor: AccountId, deposit_yocto: u128, timestamp: u64, balance_near: u128) {
        testing_env!(context(predecessor, deposit_yocto, timestamp, balance_near));
    }

    const T0: u64 = 1_700_000_000_000_000_000;

    fn boot() -> Vault {
        use_context(owner(), 1, T0, 20);
        let mut vault_contract = Vault::new(owner(), agent());
        vault_contract.set_policy(
            vec![vendor()],
            NearToken::from_near(1),
            NearToken::from_near(2),
        );
        vault_contract
    }

    fn as_agent(vault_contract: &mut Vault, timestamp: u64) {
        use_context(agent(), 0, timestamp, 20);
        let _ = vault_contract;
    }

    #[test]
    fn near_token_json_is_a_yocto_string() {
        let encoded = near_sdk::serde_json::to_string(&NearToken::from_near(1)).unwrap();
        assert_eq!(encoded, "\"1000000000000000000000000\"");
    }

    #[test]
    fn default_policy_does_not_auto_release() {
        use_context(owner(), 0, T0, 20);
        let mut vault_contract = Vault::new(owner(), agent());
        use_context(agent(), 0, T0, 20);
        let result = vault_contract.request_spend(vendor(), NearToken::from_near(1), "boot".into());
        assert_eq!(result.decision, "queued");
        assert_eq!(result.reason, "not_allowlisted");
        assert_eq!(vault_contract.get_pending().len(), 1);
        use_context(owner(), 1, T0, 20);
        vault_contract.set_policy(
            vec![vendor()],
            NearToken::from_yoctonear(0),
            NearToken::from_yoctonear(0),
        );
        use_context(agent(), 0, T0, 20);
        let capped = vault_contract.request_spend(vendor(), NearToken::from_yoctonear(1), "cap".into());
        assert_eq!(capped.decision, "queued");
        assert_eq!(capped.reason, "over_per_tx");
        assert_eq!(
            vault_contract.get_daily_spent(),
            NearToken::from_yoctonear(0)
        );
    }

    #[test]
    fn in_policy_spend_is_released_and_counts_toward_the_day() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let result = vault_contract.request_spend(
            vendor(),
            NearToken::from_millinear(500),
            "api credits".into(),
        );
        assert_eq!(result.decision, "released");
        assert_eq!(result.reason, "in_policy");
        assert!(vault_contract.get_pending().is_empty());
        assert_eq!(
            vault_contract.get_daily_spent(),
            NearToken::from_millinear(500)
        );
        let logs = get_logs();
        assert!(logs.iter().any(|line| line.contains("\"event\":\"proposal\"")));
        assert!(logs.iter().any(|line| line.contains("\"event\":\"released\"")));
    }

    #[test]
    fn amount_equal_to_both_caps_is_released() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let result =
            vault_contract.request_spend(vendor(), NearToken::from_near(1), "exact".into());
        assert_eq!(result.decision, "released");
        as_agent(&mut vault_contract, T0);
        let second =
            vault_contract.request_spend(vendor(), NearToken::from_near(1), "exact again".into());
        assert_eq!(second.decision, "released");
        as_agent(&mut vault_contract, T0);
        let third =
            vault_contract.request_spend(vendor(), NearToken::from_yoctonear(1), "one more".into());
        assert_eq!(third.decision, "queued");
        assert_eq!(third.reason, "over_daily");
    }

    #[test]
    fn over_per_tx_is_queued_and_does_not_spend_the_daily_budget() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let result =
            vault_contract.request_spend(vendor(), NearToken::from_millinear(1500), "too big".into());
        assert_eq!(result.decision, "queued");
        assert_eq!(result.reason, "over_per_tx");
        assert_eq!(vault_contract.get_pending().len(), 1);
        assert_eq!(
            vault_contract.get_daily_spent(),
            NearToken::from_yoctonear(0)
        );
    }

    #[test]
    fn not_allowlisted_receiver_is_queued() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let result =
            vault_contract.request_spend(other(), NearToken::from_millinear(10), "stranger".into());
        assert_eq!(result.decision, "queued");
        assert_eq!(result.reason, "not_allowlisted");
    }

    #[test]
    fn paused_denies_without_a_queue_entry() {
        let mut vault_contract = boot();
        use_context(owner(), 1, T0, 20);
        vault_contract.set_paused(true);
        as_agent(&mut vault_contract, T0);
        let result =
            vault_contract.request_spend(vendor(), NearToken::from_millinear(10), "while paused".into());
        assert_eq!(result.decision, "denied");
        assert_eq!(result.reason, "paused");
        assert!(vault_contract.get_pending().is_empty());
    }

    #[test]
    fn zero_amount_is_denied() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let result =
            vault_contract.request_spend(vendor(), NearToken::from_yoctonear(0), "nothing".into());
        assert_eq!(result.decision, "denied");
        assert_eq!(result.reason, "zero_amount");
    }

    #[test]
    fn paying_the_vault_itself_is_denied() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let result =
            vault_contract.request_spend(vault(), NearToken::from_millinear(10), "loop".into());
        assert_eq!(result.decision, "denied");
        assert_eq!(result.reason, "receiver_is_vault");
        assert!(vault_contract.get_pending().is_empty());
    }

    #[test]
    #[should_panic(expected = "vault cannot be on the allowlist")]
    fn allowlist_rejects_the_vault_account() {
        let mut vault_contract = boot();
        use_context(owner(), 1, T0, 20);
        vault_contract.set_policy(
            vec![vault()],
            NearToken::from_near(1),
            NearToken::from_near(2),
        );
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn approve_requires_one_yocto() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let queued =
            vault_contract.request_spend(other(), NearToken::from_near(1), "hold".into());
        use_context(owner(), 0, T0, 20);
        vault_contract.approve_spend(queued.spend_id.unwrap());
    }

    #[test]
    #[should_panic(expected = "only the owner can do that")]
    fn agent_cannot_approve_even_with_one_yocto() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let queued =
            vault_contract.request_spend(other(), NearToken::from_near(1), "hold".into());
        use_context(agent(), 1, T0, 20);
        vault_contract.approve_spend(queued.spend_id.unwrap());
    }

    #[test]
    #[should_panic(expected = "only the agent can request a spend")]
    fn owner_account_cannot_request_a_spend() {
        let mut vault_contract = boot();
        use_context(owner(), 0, T0, 20);
        vault_contract.request_spend(vendor(), NearToken::from_millinear(1), "no".into());
    }

    #[test]
    fn owner_approval_releases_an_over_limit_spend() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let queued = vault_contract.request_spend(
            vendor(),
            NearToken::from_millinear(1500),
            "needs a human".into(),
        );
        assert_eq!(queued.reason, "over_per_tx");
        use_context(owner(), 1, T0, 20);
        let approved = vault_contract.approve_spend(queued.spend_id.unwrap());
        assert_eq!(approved.decision, "released");
        assert_eq!(approved.reason, "owner_approved");
        assert!(vault_contract.get_pending().is_empty());
        assert_eq!(
            vault_contract.get_daily_spent(),
            NearToken::from_millinear(1500)
        );
        let actions: Vec<_> = vault_contract
            .get_audit(20)
            .into_iter()
            .map(|entry| entry.action)
            .collect();
        assert!(actions.contains(&"proposal".to_string()));
        assert!(actions.contains(&"queued".to_string()));
        assert!(actions.contains(&"approved".to_string()));
        assert!(actions.contains(&"released".to_string()));
    }

    #[test]
    fn owner_rejection_removes_the_pending_spend() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let queued =
            vault_contract.request_spend(other(), NearToken::from_millinear(10), "nope".into());
        use_context(owner(), 1, T0, 20);
        let rejected = vault_contract.reject_spend(queued.spend_id.unwrap(), "not this receiver".into());
        assert_eq!(rejected.decision, "rejected");
        assert!(vault_contract.get_pending().is_empty());
        assert_eq!(
            vault_contract.get_daily_spent(),
            NearToken::from_yoctonear(0)
        );
        assert!(vault_contract
            .get_audit(10)
            .iter()
            .any(|entry| entry.action == "rejected"));
    }

    #[test]
    fn approval_while_paused_does_not_release() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let queued =
            vault_contract.request_spend(other(), NearToken::from_millinear(10), "later".into());
        use_context(owner(), 1, T0, 20);
        vault_contract.set_paused(true);
        let result = vault_contract.approve_spend(queued.spend_id.unwrap());
        assert_eq!(result.decision, "denied");
        assert_eq!(result.reason, "paused");
        assert_eq!(vault_contract.get_pending().len(), 1);
    }

    #[test]
    fn daily_window_resets_on_the_next_period() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        assert_eq!(
            vault_contract
                .request_spend(vendor(), NearToken::from_near(2), "fill the day".into())
                .decision,
            "queued"
        );
        // 2 NEAR is over the 1 NEAR per transaction cap, so use two releases.
        vault_contract.pending.clear();
        as_agent(&mut vault_contract, T0);
        assert_eq!(
            vault_contract
                .request_spend(vendor(), NearToken::from_near(1), "first".into())
                .decision,
            "released"
        );
        as_agent(&mut vault_contract, T0);
        assert_eq!(
            vault_contract
                .request_spend(vendor(), NearToken::from_near(1), "second".into())
                .decision,
            "released"
        );
        as_agent(&mut vault_contract, T0);
        assert_eq!(
            vault_contract
                .request_spend(vendor(), NearToken::from_yoctonear(1), "blocked".into())
                .reason,
            "over_daily"
        );
        as_agent(&mut vault_contract, T0 + DAY_NS);
        let reset = vault_contract.request_spend(vendor(), NearToken::from_near(1), "new day".into());
        assert_eq!(reset.decision, "released");
        assert_eq!(vault_contract.get_daily_spent(), NearToken::from_near(1));
    }

    #[test]
    fn insufficient_balance_is_queued() {
        use_context(owner(), 1, T0, 1);
        let mut vault_contract = Vault::new(owner(), agent());
        vault_contract.set_policy(
            vec![vendor()],
            NearToken::from_near(5),
            NearToken::from_near(5),
        );
        // Balance is 1 NEAR and the reserve is 0.1 NEAR, so 1 NEAR does not fit.
        use_context(agent(), 0, T0, 1);
        let result =
            vault_contract.request_spend(vendor(), NearToken::from_near(1), "too poor".into());
        assert_eq!(result.decision, "queued");
        assert_eq!(result.reason, "insufficient_balance");
    }

    #[test]
    fn queue_full_denies_the_next_proposal() {
        let mut vault_contract = boot();
        for index in 0..MAX_PENDING {
            as_agent(&mut vault_contract, T0);
            let result = vault_contract.request_spend(
                other(),
                NearToken::from_yoctonear(1 + index as u128),
                format!("item {index}"),
            );
            assert_eq!(result.decision, "queued");
        }
        as_agent(&mut vault_contract, T0);
        let overflow = vault_contract.request_spend(other(), NearToken::from_near(1), "overflow".into());
        assert_eq!(overflow.decision, "denied");
        assert_eq!(overflow.reason, "queue_full");
        assert_eq!(vault_contract.get_pending().len(), MAX_PENDING);
    }

    #[test]
    fn audit_log_drops_the_oldest_entry() {
        use_context(owner(), 1, T0, 20);
        let mut vault_contract = Vault::new(owner(), agent());
        for _ in 0..=MAX_AUDIT {
            use_context(owner(), 1, T0, 20);
            vault_contract.set_policy(vec![], NearToken::from_yoctonear(0), NearToken::from_yoctonear(0));
        }
        assert_eq!(vault_contract.get_policy().audit_count, MAX_AUDIT as u32);
        let newest = vault_contract.get_audit(1);
        assert_eq!(newest[0].seq, (MAX_AUDIT as u64) + 1);
        let oldest_kept = vault_contract.audit.first().unwrap();
        assert_eq!(oldest_kept.seq, 2);
    }

    #[test]
    #[should_panic(expected = "only the owner can do that")]
    fn policy_change_rejects_the_agent() {
        let mut vault_contract = boot();
        use_context(agent(), 1, T0, 20);
        vault_contract.set_policy(
            vec![vendor()],
            NearToken::from_near(1),
            NearToken::from_near(1),
        );
    }

    #[test]
    #[should_panic(expected = "per transaction cap cannot exceed the daily cap")]
    fn per_tx_cap_cannot_exceed_the_daily_cap() {
        let mut vault_contract = boot();
        use_context(owner(), 1, T0, 20);
        vault_contract.set_policy(
            vec![vendor()],
            NearToken::from_near(3),
            NearToken::from_near(1),
        );
    }

    #[test]
    fn failed_transfer_reverses_the_daily_tally() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let released =
            vault_contract.request_spend(vendor(), NearToken::from_near(1), "ship".into());
        assert_eq!(vault_contract.get_daily_spent(), NearToken::from_near(1));
        let window = vault_contract.window_start_ns;
        testing_env!(
            context(vault(), 0, T0, 19),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            std::collections::HashMap::<String, NearToken>::new(),
            vec![near_sdk::PromiseResult::Failed],
        );
        vault_contract.on_transfer(
            released.spend_id.unwrap(),
            NearToken::from_near(1),
            window,
            vendor(),
        );
        assert_eq!(
            vault_contract.get_daily_spent(),
            NearToken::from_yoctonear(0)
        );
        assert!(vault_contract
            .get_audit(5)
            .iter()
            .any(|entry| entry.action == "execution_failed"));
    }

    #[test]
    fn successful_transfer_keeps_the_daily_tally() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let released =
            vault_contract.request_spend(vendor(), NearToken::from_near(1), "ship".into());
        let window = vault_contract.window_start_ns;
        testing_env!(
            context(vault(), 0, T0, 19),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            std::collections::HashMap::<String, NearToken>::new(),
            vec![near_sdk::PromiseResult::Successful(vec![])],
        );
        vault_contract.on_transfer(
            released.spend_id.unwrap(),
            NearToken::from_near(1),
            window,
            vendor(),
        );
        assert_eq!(vault_contract.get_daily_spent(), NearToken::from_near(1));
        assert!(vault_contract
            .get_audit(5)
            .iter()
            .any(|entry| entry.action == "executed" && entry.reason == "transfer_ok"));
    }

    #[test]
    fn approval_with_no_balance_keeps_the_spend_queued() {
        let mut vault_contract = boot();
        as_agent(&mut vault_contract, T0);
        let queued =
            vault_contract.request_spend(other(), NearToken::from_near(5), "big".into());
        use_context(owner(), 1, T0, 1);
        let result = vault_contract.approve_spend(queued.spend_id.unwrap());
        assert_eq!(result.reason, "insufficient_balance");
        assert_eq!(vault_contract.get_pending().len(), 1);
    }

    #[test]
    #[should_panic(expected = "Method is private")]
    fn agent_cannot_call_the_transfer_callback() {
        let mut vault_contract = boot();
        use_context(agent(), 0, T0, 20);
        vault_contract.on_transfer(1, NearToken::from_near(1), T0, vendor());
    }
}
