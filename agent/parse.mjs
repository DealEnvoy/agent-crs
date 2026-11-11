const ACCOUNT_RE =
  /(?:^|[^a-z0-9._-])((?:[a-z0-9]+(?:[-_][a-z0-9]+)*)(?:\.(?:[a-z0-9]+(?:[-_][a-z0-9]+)*))+)/gi;
const AMOUNT_RE = /(\d+(?:\.\d+)?)\s*near\b/i;

function findAccount(text) {
  ACCOUNT_RE.lastIndex = 0;
  let match;
  while ((match = ACCOUNT_RE.exec(text))) {
    const id = match[1].toLowerCase();
    if (/[a-z]/.test(id)) return id;
  }
  return null;
}

export function nearToYocto(amount) {
  const raw = String(amount).trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error("Amount must be a decimal number of NEAR.");
  }
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > 24) {
    throw new Error("NEAR amounts support at most 24 decimal places.");
  }
  const fracPadded = `${frac}${"0".repeat(24)}`.slice(0, 24);
  return (BigInt(whole) * 10n ** 24n + BigInt(fracPadded)).toString();
}

export function yoctoToNear(yocto) {
  const value = BigInt(yocto);
  const scale = 10n ** 24n;
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function aliasHit(text, aliases) {
  const lower = text.toLowerCase();
  return aliases.find((entry) => new RegExp(`\\b${entry.alias}\\b`, "i").test(lower));
}

export function parseOffline(text, aliases = []) {
  const source = String(text ?? "");
  const amountMatch = source.match(AMOUNT_RE);
  let receiverId = findAccount(source);
  if (!receiverId) {
    const hit = aliasHit(source, aliases);
    if (hit) receiverId = hit.accountId;
  }
  if (!amountMatch) {
    return { ok: false, error: "Include an amount such as 0.05 NEAR." };
  }
  if (!receiverId) {
    return {
      ok: false,
      error: "Include a receiver account id, or the word vendor or other.",
    };
  }
  let amountYocto;
  try {
    amountYocto = nearToYocto(amountMatch[1]);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return {
    ok: true,
    receiverId,
    amountYocto,
    amountNear: amountMatch[1],
    memo: source.trim().slice(0, 280),
    interpreter: "offline",
    model: null,
    note: "No model was called. The offline parser read the sentence.",
  };
}

function accountIsAllowed(receiverId, text, aliases) {
  const lower = text.toLowerCase();
  if (lower.includes(String(receiverId).toLowerCase())) return true;
  return aliases.some(
    (entry) =>
      entry.accountId === receiverId && new RegExp(`\\b${entry.alias}\\b`, "i").test(lower),
  );
}

export async function interpretSpend(text, aliases = [], env = process.env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return parseOffline(text, aliases);

  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  const known = aliases
    .map((entry) => `${entry.alias}: ${entry.accountId}`)
    .join("\n");
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Extract one NEAR spend. Reply with JSON only: {\"receiver_id\": string or null, \"amount_near\": string or null, \"memo\": string}. amount_near is a decimal NEAR amount. Use a known alias only when the user names that alias. Do not invent an account.",
          },
          {
            role: "user",
            content: `Known accounts:\n${known || "(none)"}\n\nRequest: ${text}`,
          },
        ],
      }),
    });
    if (!response.ok) {
      const fallback = parseOffline(text, aliases);
      return {
        ...fallback,
        note: `The model request failed (${response.status}). No model output was used. The offline parser read the sentence.`,
      };
    }
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content);
    const reportedModel = payload.model || model;
    if (!parsed.receiver_id || parsed.amount_near == null) {
      const fallback = parseOffline(text, aliases);
      return {
        ...fallback,
        note: "The model did not return a receiver and an amount. No model output was used. The offline parser read the sentence.",
      };
    }
    const receiverId = String(parsed.receiver_id).toLowerCase();
    if (!accountIsAllowed(receiverId, text, aliases)) {
      const fallback = parseOffline(text, aliases);
      return {
        ...fallback,
        note: "The model named an account that was not in the request. That output was rejected. The offline parser read the sentence.",
      };
    }
    return {
      ok: true,
      receiverId,
      amountYocto: nearToYocto(parsed.amount_near),
      amountNear: String(parsed.amount_near),
      memo: String(parsed.memo || text).trim().slice(0, 280),
      interpreter: "openai",
      model: reportedModel,
      note: `OpenAI ${reportedModel} parsed the sentence.`,
    };
  } catch (error) {
    const fallback = parseOffline(text, aliases);
    return {
      ...fallback,
      note: `The model request could not be used (${error.message}). No model output was used. The offline parser read the sentence.`,
    };
  }
}
