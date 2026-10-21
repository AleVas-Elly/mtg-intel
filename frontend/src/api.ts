// Data from the Worker. Every document is kept in localStorage too, so the app paints instantly
// from the last copy and then refreshes (the Worker answers 304 when nothing changed).

import { useEffect, useState } from "preact/hooks";

export class SignedOut extends Error {}

interface Stored<T> { etag: string | null; at: number; doc: T }

const memory = new Map<string, Stored<unknown>>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();

function read<T>(key: string): Stored<T> | null {
  if (memory.has(key)) return memory.get(key) as Stored<T>;
  try {
    const raw = localStorage.getItem(`doc:${key}`);
    if (raw) {
      const stored = JSON.parse(raw) as Stored<T>;
      memory.set(key, stored);
      return stored;
    }
  } catch {
    /* private mode or full storage: fine, just slower */
  }
  return null;
}

function write<T>(key: string, stored: Stored<T>) {
  memory.set(key, stored);
  try {
    localStorage.setItem(`doc:${key}`, JSON.stringify(stored));
  } catch {
    /* too big or blocked: memory copy still works */
  }
  listeners.get(key)?.forEach((f) => f());
}

/** The copy in hand, if any (no request). */
export function peek<T>(key: string): T | null | undefined {
  const stored = read<T>(key);
  return stored ? stored.doc : undefined;
}

let onSignedOut: () => void = () => {};
export function whenSignedOut(f: () => void) {
  onSignedOut = f;
}

export async function refresh(key: string, persist = true): Promise<void> {
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const cached = read(key);
    const response = await fetch(`/api/data/${key}`, {
      headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
      cache: "no-cache",
      credentials: "same-origin",
    });
    if (response.status === 401) {
      onSignedOut();
      throw new SignedOut();
    }
    if (response.status === 304 && cached) {
      cached.at = Date.now();
      return;
    }
    if (response.status === 404) {
      write(key, { etag: null, at: Date.now(), doc: null });
      return;
    }
    if (!response.ok) throw new Error(`${key}: ${response.status}`);
    const doc = await response.json();
    const stored = { etag: response.headers.get("ETag"), at: Date.now(), doc };
    if (persist) write(key, stored);
    else {
      memory.set(key, stored);
      listeners.get(key)?.forEach((f) => f());
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export interface DocState<T> { doc: T | null | undefined; error: string | null; loading: boolean }

/** A document, refreshed on mount, when the tab comes back, and every `everyMs` while visible. */
export function useDoc<T>(key: string | null, everyMs = 0, persist = true): DocState<T> {
  const [, tick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!key) return;
    const update = () => tick((n) => n + 1);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(update);
    let alive = true;
    const load = () => {
      setLoading(true);
      refresh(key, persist)
        .then(() => alive && setError(null))
        .catch((e) => alive && !(e instanceof SignedOut) && setError(navigator.onLine ? "Couldn't load the latest data." : "You're offline."))
        .finally(() => alive && setLoading(false));
    };
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    const timer = everyMs ? setInterval(() => document.visibilityState === "visible" && load(), everyMs) : 0;
    return () => {
      alive = false;
      listeners.get(key)?.delete(update);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
  }, [key]);
  const stored = key ? read<T>(key) : null;
  return { doc: stored ? stored.doc : undefined, error, loading };
}

export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status})`);
  return data as T;
}

/** Replace a document in the cache (and on screen) with what the Worker just answered. */
export function setLocal<T>(key: string, doc: T) {
  write(key, { etag: null, at: Date.now(), doc });
}

export async function send<T>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method, credentials: "same-origin",
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) {
    onSignedOut();
    throw new SignedOut();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status})`);
  return data as T;
}
