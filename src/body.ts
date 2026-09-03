// Parse Slack Web API request bodies. @slack/web-api sends
// application/x-www-form-urlencoded with nested values JSON-stringified;
// other SDKs send application/json; legacy file uploads send multipart.

export type Args = Record<string, unknown>;

const JSON_FIELDS = new Set([
  "blocks",
  "attachments",
  "metadata",
  "files",
  "view",
  "prompts",
  "icons",
  "user_ids",
  "types",
  "chunks",
  "loading_messages",
]);

function coerce(key: string, value: string): unknown {
  // Only the fields the SDKs JSON-stringify are parsed; `text` and friends stay opaque strings.
  if (JSON_FIELDS.has(key)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export async function parseArgs(req: Request): Promise<Args> {
  const url = new URL(req.url);
  const args: Args = {};
  for (const [k, v] of url.searchParams) args[k] = coerce(k, v);
  if (req.method !== "POST") return args;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await req.text();
    if (text.trim()) Object.assign(args, JSON.parse(text));
    return args;
  }
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    form.forEach((v, k) => {
      args[k] = typeof v === "string" ? coerce(k, v) : v;
    });
    return args;
  }
  const text = await req.text();
  if (!text) return args;
  for (const [k, v] of new URLSearchParams(text)) args[k] = coerce(k, v);
  return args;
}

export function bearerToken(req: Request, args: Args): string | undefined {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  if (typeof args.token === "string") return args.token;
  return undefined;
}

export function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : v == null ? undefined : String(v);
}

export function num(args: Args, key: string, fallback: number): number {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1" || v === 1) return true;
  if (v === "false" || v === "0" || v === 0) return false;
  return undefined;
}
