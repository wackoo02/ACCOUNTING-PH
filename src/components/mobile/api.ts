"use client";
// Thin client for /api/mobile. The token and chosen company live in localStorage on the phone.

const KEY = "veritus.mobile.session";
export type Session = { token: string; companyId: string; user: { id: string; name: string; email: string }; companies: { id: string; name: string; role: string }[] };

export function loadSession(): Session | null {
  try { const s = localStorage.getItem(KEY); return s ? (JSON.parse(s) as Session) : null; } catch { return null; }
}
export function saveSession(s: Session | null) {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private mode */ }
}

export class ApiFail extends Error {
  constructor(public status: number, public errors: string[]) { super(errors.join("\n")); }
}

let current: Session | null = null;
export const setCurrent = (s: Session | null) => { current = s; };
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/mobile/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(current ? { authorization: `Bearer ${current.token}`, "x-company-id": current.companyId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({ errors: ["The server sent an unexpected reply"] }));
  if (res.status === 401 && path !== "auth/login") onUnauthorized();
  if (!res.ok) throw new ApiFail(res.status, (data as { errors?: string[] }).errors ?? ["Something went wrong"]);
  return data as T;
}

export const imageUrl = (id: string) => `/api/mobile/receipts/${id}/image`;

/** Shrink a phone photo to at most 1600px (JPEG) so uploads stay small and fast. */
export async function photoToBase64(file: File): Promise<{ base64: string; mediaType: string; preview: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.82);
    return { base64: dataUrl.split(",")[1], mediaType: "image/jpeg", preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fetch the receipt image with the bearer token (img tags cannot send it). */
export async function fetchImage(id: string): Promise<string | null> {
  if (!current) return null;
  const r = await fetch(imageUrl(id), { headers: { authorization: `Bearer ${current.token}`, "x-company-id": current.companyId } });
  if (!r.ok) return null;
  return URL.createObjectURL(await r.blob());
}

export const peso = (v: string | number | null | undefined) =>
  "₱" + Number(v ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
