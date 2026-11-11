"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { actionLabel, formatNear, formatTime, reasonLabel } from "@/lib/format";
import type { BoardResponse } from "@/lib/types";

function shortAccount(account: string) {
  return account;
}

export function Board() {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("Pay 0.1 NEAR to vendor for RPC access");
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/board", { cache: "no-store" });
      const payload = (await response.json()) as BoardResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || "The vault could not be read.");
      setData(payload);
      setLoadError(null);
      return payload;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The vault could not be read.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  async function refreshUntil(check: (payload: BoardResponse) => boolean) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const payload = await refresh();
      if (payload && check(payload)) return payload;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return null;
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 12000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function propose(event: React.FormEvent) {
    event.preventDefault();
    setBusy("propose");
    setFormError(null);
    setProposal(null);
    try {
      const response = await fetch("/api/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json();
      if (!response.ok && !payload.decision && !payload.error && payload.ok !== false) {
        throw new Error(payload.error || "The proposal failed.");
      }
      if (payload.error && payload.ok == null) throw new Error(payload.error);
      setProposal(payload);
      const spendId = payload.decision?.spend_id;
      if (payload.decision?.decision === "queued" && spendId) {
        await refreshUntil((board) => board.board.pending.some((spend) => spend.id === spendId));
      } else if (payload.decision?.decision === "released" && spendId) {
        await refreshUntil((board) =>
          board.board.audit.some((entry) => entry.spend_id === spendId && entry.action === "executed"),
        );
      } else {
        await refresh();
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The proposal failed.");
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: number, action: "approve" | "reject") {
    setBusy(`${action}-${id}`);
    setFormError(null);
    try {
      const response = await fetch("/api/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "The decision failed.");
      setProposal(payload);
      await refreshUntil((board) => {
        const stillWaiting = board.board.pending.some((spend) => spend.id === id);
        if (action === "reject") return !stillWaiting;
        return (
          !stillWaiting &&
          board.board.audit.some((entry) => entry.spend_id === id && entry.action === "executed")
        );
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The decision failed.");
    } finally {
      setBusy(null);
    }
  }

  const policy = data?.board.policy;
  const spent = policy ? BigInt(policy.daily_spent) : 0n;
  const cap = policy ? BigInt(policy.max_per_day) : 1n;
  const ratio = cap === 0n ? 0 : Number((spent * 10000n) / cap) / 100;
  const meter = Math.max(0, Math.min(100, ratio));
  const decision = (proposal?.decision ?? null) as { decision?: string; reason?: string; spend_id?: number } | null;
  const interpreter = typeof proposal?.interpreter === "string" ? proposal.interpreter : null;

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="mb-8 border-b border-[#ddd4c4] pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#8f3228]">
          NEAR testnet · Track 06
        </p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-[family-name:var(--font-fraunces)] text-5xl font-medium tracking-tight text-[#1c1915] sm:text-6xl">
              Agent CRS
            </h1>
            <p className="mt-2 max-w-xl text-lg text-[#3c3832]">
              Certificate of Release for Spend. The vault holds the NEAR. The agent can only ask.
            </p>
          </div>
          {data && (
            <a
              className="font-[family-name:var(--font-mono)] text-xs text-[#5c564c] underline decoration-[#cfc6b6] underline-offset-4"
              href={data.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              {data.contractId}
            </a>
          )}
        </div>
      </header>

      {loading && !data && (
        <p className="text-[#5c564c]" role="status">
          Reading the vault…
        </p>
      )}

      {loadError && (
        <div className="sheet mb-6 p-4" role="alert">
          <p className="font-medium">The vault could not be read.</p>
          <p className="mt-1 text-sm text-[#5c564c]">{loadError}</p>
          <Button className="mt-3" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      )}

      {policy && data && (
        <>
          <section className="mb-6 grid gap-3 sm:grid-cols-3" aria-label="Vault status">
            <Status
              label="Gate"
              value={policy.paused ? "Paused" : "Open"}
              detail={policy.paused ? "New spends are denied." : "In policy spends can release."}
            />
            <Status
              label="Daily spent"
              value={`${formatNear(policy.daily_spent)} NEAR`}
              detail={`Cap ${formatNear(policy.max_per_day)} NEAR`}
            />
            <Status
              label="Available"
              value={`${formatNear(policy.available_balance)} NEAR`}
              detail={`Balance ${formatNear(policy.vault_balance)} NEAR`}
            />
          </section>

          <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <section id="policy" className="sheet p-5">
              <h2 className="font-[family-name:var(--font-fraunces)] text-2xl">Policy</h2>
              <p className="mt-1 text-sm text-[#5c564c]">Default deny. Unknown receivers wait for the owner.</p>
              <dl className="mt-4 space-y-3 text-sm">
                <Row label="Per transaction" value={`${formatNear(policy.max_per_tx)} NEAR`} />
                <Row label="Per day" value={`${formatNear(policy.max_per_day)} NEAR`} />
                <div>
                  <div className="mb-1 flex justify-between text-[#5c564c]">
                    <dt>Today</dt>
                    <dd className="font-[family-name:var(--font-mono)] text-[#1c1915]">
                      {formatNear(policy.daily_spent)} / {formatNear(policy.max_per_day)}
                    </dd>
                  </div>
                  <div className="meter" aria-hidden="true">
                    <span style={{ width: `${meter}%` }} />
                  </div>
                </div>
                <Row label="Owner" value={shortAccount(policy.owner)} />
                <Row label="Agent" value={shortAccount(policy.agent)} />
              </dl>
              <h3 className="mt-5 text-xs font-medium uppercase tracking-[0.16em] text-[#5c564c]">Allowlist</h3>
              {policy.allowlist.length === 0 ? (
                <p className="mt-2 text-sm">No receiver is allowlisted. Every spend waits.</p>
              ) : (
                <ul className="mt-2 space-y-1 font-[family-name:var(--font-mono)] text-xs">
                  {policy.allowlist.map((account) => (
                    <li key={account}>{account}</li>
                  ))}
                </ul>
              )}
              <h3 className="mt-5 text-xs font-medium uppercase tracking-[0.16em] text-[#5c564c]">Agent key</h3>
              {data.agentKeys.length === 0 ? (
                <p className="mt-2 text-sm text-[#5c564c]">Key list was not returned by the RPC.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {data.agentKeys.map((key, index) => (
                    <li key={`${key.kind}-${index}`}>
                      {key.kind === "function_call"
                        ? `Function call only. Methods: ${(key.methods ?? []).join(", ") || "all methods on one contract"}. Receiver: ${key.receiverId}.`
                        : key.kind === "full_access"
                          ? "Full access key. This account can do more than ask."
                          : "Unrecognised key permission."}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section id="propose" className="sheet p-5">
              <h2 className="font-[family-name:var(--font-fraunces)] text-2xl">Ask for a spend</h2>
              <p className="mt-1 text-sm text-[#5c564c]">
                Plain language. The agent key calls request_spend with no deposit.
              </p>
              <form className="mt-4 space-y-3" onSubmit={propose}>
                <label className="block text-sm font-medium" htmlFor="spend-text">
                  Sentence
                </label>
                <textarea
                  id="spend-text"
                  className="min-h-28 w-full border border-[#ddd4c4] bg-white px-3 py-2 text-sm text-[#1c1915] outline-none focus:border-[#1c1915]"
                  value={text}
                  maxLength={280}
                  onChange={(event) => setText(event.target.value)}
                />
                <Button type="submit" disabled={busy !== null || !data.canPropose}>
                  {busy === "propose" ? "Asking the vault…" : "Ask the vault"}
                </Button>
                {!data.canPropose && (
                  <p className="text-sm text-[#5c564c]">
                    This copy of the board can read the vault. Proposing needs the agent key on the server, and that key is not in the repository.
                  </p>
                )}
              </form>
              {formError && (
                <p className="mt-4 text-sm text-[#8f3228]" role="alert">
                  {formError}
                </p>
              )}
              {proposal && (
                <div className="mt-5 border-t border-[#ddd4c4] pt-4" data-testid="proposal-result">
                  {interpreter && (
                    <p className="text-sm text-[#5c564c]">
                      {typeof proposal.note === "string"
                        ? proposal.note
                        : interpreter === "openai"
                          ? `Parsed by ${String(proposal.model)}.`
                          : "Offline parser. No model was called."}
                    </p>
                  )}
                  {decision?.decision && (
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <p className="text-sm">
                        {reasonLabel(decision.reason || "")}
                        {decision.spend_id ? ` · spend ${decision.spend_id}` : ""}
                      </p>
                      <span
                        className="stamp"
                        style={{
                          color:
                            decision.decision === "released"
                              ? "#1c6b43"
                              : decision.decision === "queued"
                                ? "#8a5a12"
                                : "#8f3228",
                        }}
                      >
                        {decision.decision}
                      </span>
                    </div>
                  )}
                  {typeof proposal.explorerUrl === "string" && (
                    <a
                      className="mt-3 inline-block font-[family-name:var(--font-mono)] text-xs underline"
                      href={proposal.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Transaction
                    </a>
                  )}
                </div>
              )}
            </section>
          </div>

          <section id="pending" className="sheet mt-6 p-5">
            <h2 className="font-[family-name:var(--font-fraunces)] text-2xl">Waiting for the owner</h2>
            {data.board.pending.length === 0 ? (
              <p className="mt-3 text-sm text-[#5c564c]">
                No spend is waiting. A request inside policy releases immediately.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-[#ddd4c4]">
                {data.board.pending.map((spend) => (
                  <li key={spend.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-[family-name:var(--font-mono)] text-sm">
                        {formatNear(spend.amount)} NEAR to {spend.receiver_id}
                      </p>
                      <p className="mt-1 text-sm text-[#5c564c]">
                        {reasonLabel(spend.reason)}. {spend.memo}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy !== null || !data.canDecide}
                        onClick={() => void decide(spend.id, "approve")}
                      >
                        {busy === `approve-${spend.id}` ? "Signing…" : "Approve"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || !data.canDecide}
                        onClick={() => void decide(spend.id, "reject")}
                      >
                        {busy === `reject-${spend.id}` ? "Signing…" : "Reject"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {!data.canDecide && data.board.pending.length > 0 && (
              <p className="mt-2 text-sm text-[#5c564c]">
                Approval needs the owner key on the server. That key is not in the repository.
              </p>
            )}
          </section>

          <section id="audit" className="sheet mt-6 p-5">
            <h2 className="font-[family-name:var(--font-fraunces)] text-2xl">Audit log</h2>
            <p className="mt-1 text-sm text-[#5c564c]">Written by the contract. Newest first.</p>
            {data.board.audit.length === 0 ? (
              <p className="mt-3 text-sm">No decisions yet.</p>
            ) : (
              <>
              <ul className="mt-4 space-y-3 md:hidden">
                {data.board.audit.map((entry) => (
                  <li key={entry.seq} className="border-t border-[#eee6d8] pt-3">
                    <p className="text-xs text-[#5c564c]">{formatTime(entry.ts_ns)}</p>
                    <p className="mt-1 font-medium">
                      {actionLabel(entry.action)}
                      {entry.amount ? ` · ${formatNear(entry.amount)} NEAR` : ""}
                    </p>
                    <p className="text-sm text-[#3c3832]">{reasonLabel(entry.reason)}</p>
                    {entry.receiver_id && (
                      <p className="break-all font-[family-name:var(--font-mono)] text-xs">{entry.receiver_id}</p>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-4 hidden overflow-x-auto md:block">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.14em] text-[#5c564c]">
                    <tr>
                      <th className="py-2 pr-3 font-medium">When</th>
                      <th className="py-2 pr-3 font-medium">Step</th>
                      <th className="py-2 pr-3 font-medium">Amount</th>
                      <th className="py-2 font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.board.audit.map((entry) => (
                      <tr key={entry.seq} className="border-t border-[#eee6d8]">
                        <td className="py-2 pr-3 font-[family-name:var(--font-mono)] text-xs text-[#5c564c]">
                          {formatTime(entry.ts_ns)}
                        </td>
                        <td className="py-2 pr-3">{actionLabel(entry.action)}</td>
                        <td className="py-2 pr-3 font-[family-name:var(--font-mono)] text-xs">
                          {entry.amount ? `${formatNear(entry.amount)} NEAR` : ""}
                        </td>
                        <td className="break-all py-2 text-[#3c3832]">
                          {reasonLabel(entry.reason)}
                          {entry.receiver_id ? ` · ${shortAccount(entry.receiver_id)}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </section>
        </>
      )}

      <footer className="mt-8 border-t border-[#ddd4c4] pt-4 text-sm text-[#5c564c]">
        Built by Isaac Adekunle / Drew &amp; Crew with AI coding agents. Testnet only. This is a separate project from Approve before Pay.
      </footer>
    </main>
  );
}

function Status({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="sheet px-4 py-3">
      <p className="text-xs uppercase tracking-[0.16em] text-[#5c564c]">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-fraunces)] text-2xl">{value}</p>
      <p className="text-xs text-[#5c564c]">{detail}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[#5c564c]">{label}</dt>
      <dd className="text-right font-[family-name:var(--font-mono)] text-xs">{value}</dd>
    </div>
  );
}
