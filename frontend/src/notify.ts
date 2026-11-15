// App notifications on this device (spec D88): the service worker, the browser's permission and
// the push subscription, which the Worker keeps per account.

import { send } from "./api";

export type PushState =
  | "unsupported" // this browser can't get web notifications
  | "install" // iPhone or iPad in Safari: only works once the site is on the home screen
  | "denied" // the person (or the phone) said no; only the phone's settings can undo it
  | "off" // can be turned on with one tap
  | "on";

/** What rings on a device (D88; the Worker's rings.ts): 3 Steal, 2 Great, 1 Good, 0 target price. */
export interface RingSettings {
  kinds: { deals: boolean; digest: boolean; system: boolean };
  ring: 0 | 1 | 2 | 3;
  quiet: { on: boolean; from: number; to: number; steals: boolean };
  tz: string;
}
export interface PushDevice { endpoint: string; device: string; browser: string; created: string; rings: RingSettings }

export const isApple = () => /iPhone|iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function registerWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => { /* notifications just stay off */ });
}

async function subscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isApple() && !standalone() ? "install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && (await subscription()) ? "on" : "off";
}

export const currentEndpoint = async () => (await subscription())?.endpoint ?? null;

/** Ask the browser (must run from a tap on iPhone), subscribe, and tell the Worker. */
export async function turnOn(): Promise<PushDevice[]> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "denied" : "Notifications weren't allowed.");
  const { key } = await send<{ key: string | null }>("GET", "/api/push/key");
  if (!key) throw new Error("Notifications aren't set up on the server yet.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return send<PushDevice[]>("POST", "/api/push/devices", { sub: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
}

export async function turnOff(): Promise<PushDevice[]> {
  const sub = await subscription();
  const list = await send<PushDevice[]>("POST", "/api/push/devices/remove", { endpoint: sub?.endpoint ?? "" });
  await sub?.unsubscribe().catch(() => {});
  return list;
}

export const sendTest = async () => send<{ ok: true }>("POST", "/api/push/test", { endpoint: await currentEndpoint() });
export const pushDevices = () => send<PushDevice[]>("GET", "/api/push/devices");
export const saveRings = async (rings: RingSettings) =>
  send<PushDevice[]>("POST", "/api/push/devices/settings", { endpoint: await currentEndpoint(), rings });
