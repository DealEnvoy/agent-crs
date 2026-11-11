import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function repoRoot() {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, "agent", "propose.mjs"))) return cwd;
  const parent = path.resolve(cwd, "..");
  if (existsSync(path.join(parent, "agent", "propose.mjs"))) return parent;
  throw new Error("Cannot find the agent scripts.");
}

function lastJson(text: string) {
  const start = text.lastIndexOf("\n{");
  const blob = (start === -1 ? text : text.slice(start + 1)).trim();
  return JSON.parse(blob);
}

export function runAgent(script: string, args: string[]) {
  const root = repoRoot();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "agent", script), ...args], {
      cwd: root,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The testnet call took too long."));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const parsed = lastJson(stdout);
        if (code && code !== 0 && code !== 2) {
          reject(new Error(stderr.trim() || `Agent script exited ${code}`));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error(stderr.trim() || stdout.trim() || `Agent script exited ${code}`));
      }
    });
  });
}
