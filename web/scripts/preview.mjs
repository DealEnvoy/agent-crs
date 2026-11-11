import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const out = "/tmp/agent-crs-preview";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });

for (const [name, width, height] of [
  ["desktop", 1280, 800],
  ["mobile", 390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto("http://127.0.0.1:43123", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Policy" }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await page.close();
}

await browser.close();
console.log(out);
