// One short message at the bottom of the screen, optionally with an action (Undo).
import { useEffect, useState } from "preact/hooks";

export interface Toast { text: string; action?: { label: string; run: () => void }; id: number }

let current: Toast | null = null;
let timer = 0;
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((f) => f());

export function toast(text: string, action?: Toast["action"], ms = 6000) {
  current = { text, action, id: Date.now() };
  clearTimeout(timer);
  timer = window.setTimeout(() => { current = null; notify(); }, ms);
  notify();
}

export function dismissToast() {
  current = null;
  notify();
}

export function useToast(): Toast | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subscribers.add(f);
    return () => { subscribers.delete(f); };
  }, []);
  return current;
}
