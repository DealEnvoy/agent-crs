import { chromium } from "playwright";
import { mkdir, copyFile } from "node:fs/promises";
import { execSync } from "node:child_process";

const videoDir = "/tmp/agent-crs-video";
const shotDir = "/workspace/docs/demo";
const artifactDir = "/opt/cursor/artifacts";
await mkdir(videoDir, { recursive: true });
await mkdir(shotDir, { recursive: true });
await mkdir(artifactDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
const started = Date.now();
const elapsed = () => Date.now() - started;

async function caption(text) {
  await page.evaluate((value) => {
    const el = document.getElementById("demo-caption");
    if (el) el.textContent = value;
  }, text);
}

async function shot(name) {
  const previous = await page.locator("#demo-caption").textContent();
  await caption("");
  await page.screenshot({ path: `${shotDir}/${name}` });
  await caption(previous || "");
}

async function hold(ms) {
  await page.waitForTimeout(ms);
}

async function showResult() {
  await result.evaluate((el) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
  });
}

await page.goto("http://127.0.0.1:43123", { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Policy" }).waitFor({ timeout: 20000 });
await caption("Agents should not hold the keys to the vault.");
await hold(4000);
await shot("01-policy.png");
await caption("Allowlist, a per transaction cap, and a daily cap. The default is deny.");
await page.locator("#policy").scrollIntoViewIfNeeded();
await hold(4000);

await caption("Inside policy, the vault releases the spend. No model was called.");
const box = page.locator("#spend-text");
await box.fill("");
await box.pressSequentially("Pay 0.1 NEAR to vendor for RPC access", { delay: 22 });
await page.getByRole("button", { name: "Ask the vault" }).click();
const result = page.getByTestId("proposal-result");
await result.getByText("released", { exact: true }).waitFor({ timeout: 50000 });
await page.locator("#audit tbody tr").first().getByText("Executed").waitFor({ timeout: 20000 });
await showResult();
await hold(3500);

await caption("Over the cap, the spend waits. The agent key cannot approve it.");
await box.fill("");
await box.pressSequentially("Pay 1 NEAR to vendor for a retainer", { delay: 24 });
await page.getByRole("button", { name: "Ask the vault" }).click();
await page.getByRole("button", { name: "Approve" }).waitFor({ timeout: 50000 });
await page.locator("#pending").scrollIntoViewIfNeeded();
await hold(1500);
await shot("02-queued.png");
await hold(3000);

await caption("The owner signs with a full access key. One yoctoNEAR proves it is not the agent key.");
await page.getByRole("button", { name: "Approve" }).click();
await result.getByText("released", { exact: true }).waitFor({ timeout: 50000 });
await showResult();
await hold(2500);
await page.getByText("No spend is waiting").waitFor({ timeout: 20000 });
await page.locator("#audit").scrollIntoViewIfNeeded();
await hold(1500);
await shot("03-audit.png");
await caption("Every step is on chain. Agent CRS, built at NEAR Hackathon.");
const remaining = 68000 - elapsed();
if (remaining > 0) await hold(remaining);
console.log(`elapsed_ms=${elapsed()}`);

const video = page.video();
await context.close();
await browser.close();
const source = await video.path();
await copyFile(source, `${shotDir}/agent-crs-demo.webm`);
await copyFile(source, `${artifactDir}/agent-crs-demo.webm`);
await copyFile(`${shotDir}/01-policy.png`, `${artifactDir}/01-policy.png`);
await copyFile(`${shotDir}/02-queued.png`, `${artifactDir}/02-queued.png`);
await copyFile(`${shotDir}/03-audit.png`, `${artifactDir}/03-audit.png`);
const probe = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${shotDir}/agent-crs-demo.webm`).toString().trim();
console.log(`video_seconds=${probe}`);
console.log(source);
