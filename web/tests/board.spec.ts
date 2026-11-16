import { expect, test, type Page } from "@playwright/test";

const vault = "vault.acrs261111k7m2.testnet";
const vendor = "vendor.acrs261111k7m2.testnet";

function boardPayload(allowlist: string[]) {
  return {
    contractId: vault,
    ownerId: "acrs261111k7m2.testnet",
    agentId: "agent.acrs261111k7m2.testnet",
    vendorId: vendor,
    otherId: "other.acrs261111k7m2.testnet",
    explorerUrl: `https://testnet.nearblocks.io/address/${vault}`,
    canPropose: false,
    canDecide: false,
    agentKeys: [
      {
        kind: "function_call",
        receiverId: vault,
        methods: ["request_spend"],
      },
    ],
    board: {
      policy: {
        owner: "acrs261111k7m2.testnet",
        agent: "agent.acrs261111k7m2.testnet",
        paused: false,
        allowlist,
        max_per_tx: allowlist.length === 0 ? "0" : "500000000000000000000000",
        max_per_day: allowlist.length === 0 ? "0" : "10000000000000000000000000",
        daily_spent: "0",
        window_start_ns: 0,
        window_end_ns: 0,
        vault_balance: "0",
        available_balance: "0",
        pending_count: 0,
        audit_count: 0,
      },
      pending: [],
      audit: [],
    },
  };
}

async function showBoard(page: Page, allowlist: string[]) {
  await page.route("**/api/board", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(boardPayload(allowlist)),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent CRS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Policy" })).toBeVisible();
}

test("the first screen shows a function call key and refuses to propose without one", async ({ page }) => {
  await showBoard(page, [vendor]);
  await expect(page.getByText("The vault holds the NEAR. The agent can only ask.")).toBeVisible();
  await expect(page.getByText("Default deny. Unknown receivers wait for the owner.")).toBeVisible();
  await expect(page.getByText(`Function call only. Methods: request_spend. Receiver: ${vault}.`)).toBeVisible();
  await expect(page.getByText("0.5 NEAR").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask the vault" })).toBeDisabled();
  await expect(
    page.getByText("This copy of the board can read the vault. Proposing needs the agent key on the server, and that key is not in the repository."),
  ).toBeVisible();
});

test("an empty allowlist tells the reader that every spend waits", async ({ page }) => {
  await showBoard(page, []);
  await expect(page.getByText("No receiver is allowlisted. Every spend waits.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask the vault" })).toBeDisabled();
});

test("propose and approve are refused when the server has no keys", async ({ request }) => {
  const propose = await request.post("/api/propose", {
    data: { text: "Pay 0.1 NEAR to vendor for RPC access" },
  });
  expect(propose.status()).toBe(503);
  expect(await propose.json()).toEqual({
    error:
      "This server has no agent key. The board can still be read. Add NEAR_AGENT_CREDENTIALS_FILE locally. The key is not in the repository.",
  });

  const decide = await request.post("/api/decide", {
    data: { id: 1, action: "approve" },
  });
  expect(decide.status()).toBe(503);
  expect(await decide.json()).toEqual({
    error:
      "This server has no owner key. Approval needs NEAR_OWNER_CREDENTIALS_FILE locally. The key is not in the repository.",
  });
});

test("the board can read the public testnet vault", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Policy" })).toBeVisible();
  await expect(page.getByText(`Function call only. Methods: request_spend. Receiver: ${vault}.`)).toBeVisible();
  await expect(page.getByText(vendor).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask the vault" })).toBeDisabled();
});
