// Signed-session issuing/verification and password hashing — lifted verbatim
// from portal-api so every function validates tokens identically. One copy means
// the auth contract cannot drift between functions.
import { TOKEN_SECRET, TOKEN_TTL_SECONDS, enc } from "./env.ts";

// ---- crypto helpers --------------------------------------------------------
// Copy any view into a standalone ArrayBuffer so Web Crypto's BufferSource
// param types are satisfied (avoids the SharedArrayBuffer/ArrayBufferLike clash).
export function ab(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", ab(enc.encode(text))));
}
export async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ab(enc.encode(TOKEN_SECRET)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
// Constant-time-ish compare
export function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A session token carries the access tier (role) + admin flag + user identity.
export async function issueSession(payload: Record<string, unknown>, ttlSeconds = TOKEN_TTL_SECONDS): Promise<string> {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const p = b64url(enc.encode(JSON.stringify(body)));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), ab(enc.encode(p)))));
  return `${p}.${sig}`;
}
export async function verifySession(token: string | undefined): Promise<any | null> {
  if (!token || !token.includes(".")) return null;
  const [p, sig] = token.split(".");
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), ab(b64urlDecode(sig)), ab(enc.encode(p)));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (data.role !== "rushroom" && data.role !== "supplier") return null;
    return data;
  } catch { return null; }
}

// ---- password hashing (PBKDF2-SHA256) --------------------------------------
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", ab(enc.encode(pw)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: ab(salt), iterations: 120000, hash: "SHA-256" }, key, 256);
  return `pbkdf2$120000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, iterStr, saltB64, hashB64] = stored.split("$");
  if (algo !== "pbkdf2" || !saltB64 || !hashB64) return false;
  const salt = b64urlDecode(saltB64);
  const key = await crypto.subtle.importKey("raw", ab(enc.encode(pw)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: ab(salt), iterations: Number(iterStr) || 120000, hash: "SHA-256" }, key, 256);
  return eq(b64url(new Uint8Array(bits)), hashB64);
}

