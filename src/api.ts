import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const BASE = "https://api.figma.com";
const CONFIG_DIR = join(homedir(), ".config", "figma-api");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

export interface Credentials {
  token: string;
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2) + "\n");
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8"));
}

export function credentialsExist(): boolean {
  return existsSync(CREDENTIALS_FILE) || !!(process.env.FIGMA_TOKEN || process.env.FIGMA_API_TOKEN);
}

/** Resolve token from env (FIGMA_TOKEN / FIGMA_API_TOKEN) or saved credentials. */
export function loadToken(): string {
  const env = process.env.FIGMA_TOKEN || process.env.FIGMA_API_TOKEN;
  if (env) return env;
  const creds = loadCredentials();
  if (!creds?.token) {
    console.error("No token found. Run: figma-api auth <personal-access-token>");
    console.error("Or set FIGMA_TOKEN env var. Create a token at https://www.figma.com/settings (Personal access tokens).");
    process.exit(1);
  }
  return creds.token;
}

/** OAuth bearer tokens start with "figo"/"figu"; PATs use the X-Figma-Token header. */
function authHeaders(): Record<string, string> {
  const token = loadToken();
  if (token.startsWith("Bearer ") || /^fig[ou]/.test(token)) {
    return { Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` };
  }
  return { "X-Figma-Token": token };
}

function buildUrl(path: string, params?: Record<string, unknown>): string {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function request(method: string, path: string, params?: Record<string, unknown>, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { ...authHeaders() } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(buildUrl(path, params), init);
}

export const get = (path: string, params?: Record<string, unknown>) => request("GET", path, params);
export const post = (path: string, body?: unknown, params?: Record<string, unknown>) => request("POST", path, params, body ?? {});
export const put = (path: string, body?: unknown, params?: Record<string, unknown>) => request("PUT", path, params, body ?? {});
export const del = (path: string, params?: Record<string, unknown>) => request("DELETE", path, params);

/** Print a Response as pretty JSON (or raw text), exit non-zero on HTTP error. */
export async function output(res: Response): Promise<void> {
  const text = await res.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep raw */ }
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`);
    console.error(typeof data === "string" ? data : JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

/**
 * Accept a raw file key or a Figma URL and return { fileKey, nodeId? }.
 * URLs: https://www.figma.com/file|design|board/<KEY>/<name>?node-id=1-2
 * node-id query uses "1-2" form; the API expects "1:2".
 */
export function parseFigmaTarget(input: string): { fileKey: string; nodeId?: string } {
  const urlMatch = input.match(/figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/);
  const fileKey = urlMatch ? urlMatch[1] : input;
  let nodeId: string | undefined;
  const nodeMatch = input.match(/[?&]node-id=([^&]+)/);
  if (nodeMatch) nodeId = decodeURIComponent(nodeMatch[1]).replace(/-/g, ":");
  return { fileKey, nodeId };
}

/** Read JSON from an inline string or a @file.json path. */
export function readJsonArg(arg: string): unknown {
  const raw = arg.startsWith("@") ? readFileSync(arg.slice(1), "utf-8") : arg;
  return JSON.parse(raw);
}
