// Whether the Design lab panel is open (kept for this browser tab).
import { useEffect, useState } from "preact/hooks";

const subs = new Set<() => void>();
export const labOpen = () => { try { return sessionStorage.getItem("lab") === "1"; } catch { return false; } };
export function setLabOpen(open: boolean) {
  try { sessionStorage.setItem("lab", open ? "1" : "0"); } catch { /* fine */ }
  subs.forEach((f) => f());
}
export function useLabOpen(): boolean {
  const [open, set] = useState(labOpen);
  useEffect(() => { const f = () => set(labOpen()); subs.add(f); return () => { subs.delete(f); }; }, []);
  return open;
}
