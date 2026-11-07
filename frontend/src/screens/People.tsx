// People and access in Settings (spec D78): invite someone with a name, a preset and an end date;
// see who connected; change what each person can see and do; take it back.
import { renderSVG } from "uqr";
import { useEffect, useState } from "preact/hooks";
import { send } from "../api";
import { type Perm, PERM_INFO, PRESETS } from "../access";
import { ago, countryName, day } from "../format";
import { Confirm } from "../ui/Confirm";
import { IconBack, IconClose, IconPlus } from "../ui/icons";
import { toast } from "../toast";

interface Place { city?: string; country?: string }
export interface Device {
  id: string; device: string; created: string; current: boolean; account?: string;
  browser: string | null; app: string | null; place: Place | null;
  seen: { at: string; browser: string; place: Place } | null;
}
interface Person {
  id: string; name: string; created: string; expires: string | null; preset: string;
  perms: Partial<Record<Perm, boolean>>; ended: boolean; devices: Device[];
}
interface Invite { url: string; expires: string }
interface Activity { account: string; at: string; what: string }

export const where = (p: Place | null | undefined) => [p?.city, p?.country && countryName(p.country)].filter(Boolean).join(", ");
export const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

const presetName = (id: string) => PRESETS.find((p) => p.id === id)?.label ?? "Custom";
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => isoDay(new Date(Date.now() + n * 864e5));

function lastHere(p: Person): string {
  const seen = p.devices.map((d) => d.seen?.at).filter((v): v is string => !!v).sort().pop();
  if (!p.devices.length) return "Hasn't joined yet";
  return seen ? `here ${ago(seen)}` : `joined ${day(p.devices[0].created)}`;
}

function endText(p: { expires: string | null; ended?: boolean }): string {
  if (!p.expires) return "No end date";
  return p.ended ? `Ended ${day(p.expires)}` : `Until ${day(p.expires)}`;
}

/** Which access the switches give, with their dependencies: off ones that need an off switch are greyed. */
function Switches({ perms, onChange, busy }: { perms: Partial<Record<Perm, boolean>>; onChange: (p: Partial<Record<Perm, boolean>>) => void; busy?: boolean }) {
  return (
    <div class="group form">
      {PERM_INFO.map((p) => {
        const blocked = p.needs && !perms[p.needs];
        return (
          <label class={`f-row${blocked ? " off" : ""}`}>
            <span>{p.label}<small>{blocked ? `Needs ${PERM_INFO.find((x) => x.id === p.needs)!.label.toLowerCase()}` : p.hint}</small></span>
            <input type="checkbox" class="switch" checked={!!perms[p.id] && !blocked} disabled={busy || !!blocked}
              onChange={(e) => onChange({ ...perms, [p.id]: (e.target as HTMLInputElement).checked })} />
          </label>
        );
      })}
    </div>
  );
}

function Presets({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  return (
    <div class="presets" role="radiogroup" aria-label="Access">
      {PRESETS.map((p) => (
        <button type="button" role="radio" class="preset" aria-checked={value === p.id} aria-label={`${p.label}: ${p.hint}`} onClick={() => onPick(p.id)}>
          <b>{p.label}</b><small>{p.hint}</small>
        </button>
      ))}
    </div>
  );
}

const fromPreset = (id: string) => Object.fromEntries((PRESETS.find((p) => p.id === id)?.perms ?? []).map((p) => [p, true])) as Partial<Record<Perm, boolean>>;
const matchPreset = (perms: Partial<Record<Perm, boolean>>) =>
  PRESETS.find((p) => PERM_INFO.every((x) => !!perms[x.id] === p.perms.includes(x.id)))?.id ?? "custom";

/** 7 days, 30 days, no end, or a chosen day. `value` is a YYYY-MM-DD day or "". */
function Ends({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const quick = [{ v: inDays(7), label: "7 days" }, { v: inDays(30), label: "30 days" }, { v: "", label: "No end" }];
  const custom = !quick.some((q) => q.v === value);
  return (
    <div class="ends">
      <div class="seg full" role="radiogroup" aria-label="Access ends">
        {quick.map((q) => <button type="button" role="radio" aria-checked={value === q.v} aria-pressed={value === q.v} onClick={() => onChange(q.v)}>{q.label}</button>)}
      </div>
      <label class="f-row"><span>Or until<small>{value ? `Ends at the end of ${day(value)}` : "Access stays until you remove it"}</small></span>
        <span class="money text-in"><input type="date" min={inDays(1)} value={custom ? value : ""} aria-label="End date" onChange={(e) => onChange((e.target as HTMLInputElement).value)} /></span>
      </label>
    </div>
  );
}

/** The setup link as a QR code, with copy and share. */
function InviteCard({ invite, name }: { invite: Invite; name?: string }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) return nav.share({ title: "mtg-intel", text: name ? `${name}, here's your mtg-intel link` : "mtg-intel setup link", url: invite.url }).catch(() => {});
    copy();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(invite.url); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* no clipboard */ }
  };
  return (
    <div class="group invite-card">
      <div class="qr" dangerouslySetInnerHTML={{ __html: renderSVG(invite.url, { border: 1 }) }} />
      <p>{name ? `Send this to ${name}, or let them scan it.` : "Scan with the other device's camera, then create its passkey."}</p>
      <p class="hint">Works once, for 15 minutes.{name ? " Expired? Make a new one on their page." : ""}</p>
      <div class="invite-acts">
        <button class="btn sm" type="button" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
        {name && <button class="btn sm primary" type="button" onClick={share}>Share</button>}
      </div>
    </div>
  );
}

/** A new person: name, preset (or switches), end date; then their link. */
function InviteSheet({ onClose, onDone }: { onClose: () => void; onDone: (people: Person[]) => void }) {
  const [name, setName] = useState("");
  const [perms, setPerms] = useState(fromPreset("friend"));
  const [fine, setFine] = useState(false);
  const [ends, setEnds] = useState(inDays(30));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ invite: Invite; name: string } | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give them a name.");
    setBusy(true); setError(null);
    try {
      const r = await send<{ person: Person; invite: Invite; people: Person[] }>("POST", "/api/auth/people", { name: name.trim(), perms, ends: ends || null });
      setMade({ invite: r.invite, name: r.person.name });
      onDone(r.people);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div class="sheet-wrap" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="sheet" role="dialog" aria-modal="true" aria-label="Invite someone" onSubmit={save}>
        <header class="sheet-head plain">
          <div><h2>{made ? `${made.name} is invited` : "Invite someone"}</h2><p>{made ? "One more step: send them the link" : "They sign in with their own passkey"}</p></div>
          <button class="icon-btn" type="button" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>
        <div class="sheet-body">
          {made ? <InviteCard invite={made.invite} name={made.name} /> : (
            <>
              <div class="group form">
                <label class="f-row"><span>Name</span>
                  <span class="money text-in"><input value={name} maxLength={40} placeholder="Their name" autoFocus aria-label="Name"
                    onInput={(e) => setName((e.target as HTMLInputElement).value)} /></span>
                </label>
              </div>
              <div class="group-title">What they get</div>
              <Presets value={matchPreset(perms)} onPick={(id) => setPerms(fromPreset(id))} />
              <button class="link fine" type="button" aria-expanded={fine} onClick={() => setFine(!fine)}>{fine ? "Hide the switches" : "Fine-tune the switches"}</button>
              {fine && <Switches perms={perms} onChange={setPerms} />}
              <div class="group-title">Access ends</div>
              <div class="group form"><Ends value={ends} onChange={setEnds} /></div>
              {error && <p class="err">{error}</p>}
            </>
          )}
        </div>
        <footer class="sheet-foot">
          {made ? <button class="btn primary" type="button" onClick={onClose}>Done</button> : <>
            <button class="btn" type="button" onClick={onClose}>Cancel</button>
            <button class="btn primary" type="submit" disabled={busy}>{busy ? "Making the link…" : "Make the link"}</button>
          </>}
        </footer>
      </form>
    </div>
  );
}

/** One person, opened: their switches, end date, devices, a new link, what they did, remove. */
function PersonView({ p, onPeople, onRemoveDevice }: { p: Person; onPeople: (people: Person[]) => void; onRemoveDevice: (d: Device) => void }) {
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [log, setLog] = useState<Activity[] | null>(null);
  const [removing, setRemoving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/auth/activity?person=${encodeURIComponent(p.id)}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : [])).then(setLog).catch(() => setLog([]));
  }, [p.id, p.perms, p.expires, p.name, p.devices.length]);
  const update = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    try { onPeople(await send<Person[]>("PUT", `/api/auth/people/${p.id}`, body)); if (done) toast(done); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    setRemoving(false);
    try { onPeople(await send<Person[]>("DELETE", `/api/auth/people/${p.id}`)); toast(`Removed ${p.name}. They're signed out everywhere.`); }
    catch (e) { toast((e as Error).message); }
  };
  const newLink = async () => {
    try { setInvite(await send<Invite>("POST", `/api/auth/people/${p.id}/invite`)); } catch (e) { toast((e as Error).message); }
  };
  return (
    <div class="person-info">
      {p.ended && <div class="notice">Their access ended on {day(p.expires!)}. Pick a new end date to let them back in.</div>}
      <div class="group form">
        <label class="f-row"><span>Name</span>
          <span class="money text-in"><input value={renaming ?? p.name} maxLength={40} aria-label="Name"
            onInput={(e) => setRenaming((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            onBlur={() => { if (renaming != null && renaming.trim() && renaming.trim() !== p.name) update({ name: renaming.trim() }, "Renamed."); setRenaming(null); }} /></span>
        </label>
      </div>
      <div class="group-title">What they get</div>
      <Presets value={matchPreset(p.perms)} onPick={(id) => update({ preset: id }, `${p.name} is now a ${presetName(id)}.`)} />
      <Switches perms={p.perms} busy={busy} onChange={(perms) => update({ perms })} />
      <p class="hint">Changes apply on their next tap; nothing to send.</p>
      <div class="group-title">Access ends</div>
      <div class="group form"><Ends value={p.expires ? p.expires.slice(0, 10) : ""} onChange={(v) => update({ ends: v || null }, v ? `Access until ${day(v)}.` : "No end date.")} /></div>

      <div class="group-title">Their devices</div>
      <div class="group">
        {p.devices.length ? p.devices.map((d) => (
          <div class="kv"><dt>{d.device}<small>{join(d.seen?.browser ?? d.browser, where(d.seen?.place ?? d.place))}</small></dt>
            <dd>{d.seen ? `here ${ago(d.seen.at)}` : `added ${day(d.created)}`} <button class="link danger" type="button" onClick={() => onRemoveDevice(d)}>Remove</button></dd></div>
        )) : <p class="hint" style={{ padding: "12px 14px" }}>Not joined yet: they need to open their link.</p>}
        {!p.ended && <div class="kv"><dt>{p.devices.length ? "Add a device for them" : "Lost the link?"}</dt><dd><button class="btn sm" type="button" onClick={newLink}>New link</button></dd></div>}
      </div>
      {invite && <InviteCard invite={invite} name={p.name} />}

      <div class="group-title">What they did</div>
      <div class="group">
        {log === null ? <p class="hint" style={{ padding: "12px 14px" }}>Loading…</p>
          : log.length ? <ul class="activity">{log.map((a) => <li><span>{a.what}</span><time>{ago(a.at)}</time></li>)}</ul>
          : <p class="hint" style={{ padding: "12px 14px" }}>Nothing yet.</p>}
      </div>
      <button class="dev-remove" type="button" onClick={() => setRemoving(true)}>Remove {p.name}</button>
      {removing && <Confirm title={`Remove ${p.name}?`} action="Remove" onCancel={() => setRemoving(false)} onConfirm={remove}
        text="They're signed out on every device at once and can't come back without a new invite. What they did stays in the log for 90 days." />}
    </div>
  );
}

/** Settings' People section, for me only. */
export function PeopleSection({ onRemoveDevice, refreshKey }: { onRemoveDevice: (d: Device) => void; refreshKey: number }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  useEffect(() => {
    fetch("/api/auth/people", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : [])).then(setPeople).catch(() => setPeople([]));
  }, [refreshKey]);
  const others = (people ?? []).filter((p) => p.id !== "owner");
  return (
    <>
      <div class="group-title">People</div>
      <div class="group">
        {others.map((p) => {
          const shown = open === p.id;
          return (
            <div class="dev">
              <button class="dev-row" type="button" aria-expanded={shown} onClick={() => setOpen(shown ? null : p.id)}>
                <span class="dev-name">{p.name}<small>{join(presetName(p.preset), endText(p))}</small></span>
                <span class={`dev-last${p.ended ? " ended" : ""}`}>{p.ended ? "Ended" : lastHere(p)}<IconBack class="dev-chev" /></span>
              </button>
              {shown && <PersonView p={p} onPeople={setPeople} onRemoveDevice={onRemoveDevice} />}
            </div>
          );
        })}
        {people !== null && !others.length && <p class="hint" style={{ padding: "12px 14px" }}>Only you so far. Invite a friend to look around: you choose what they see and for how long.</p>}
        <div class="kv"><dt>Invite someone</dt><dd><button class="btn sm" type="button" onClick={() => setInviting(true)}><IconPlus />Invite</button></dd></div>
      </div>
      {inviting && <InviteSheet onClose={() => setInviting(false)} onDone={setPeople} />}
    </>
  );
}

/** What a guest sees about their own access. */
export function MyAccess({ name, expires, perms }: { name: string; expires: string | null; perms: Record<Perm, boolean> }) {
  const yes = PERM_INFO.filter((p) => perms[p.id]);
  return (
    <>
      <div class="group-title">Your access</div>
      <dl class="group">
        <div class="kv"><dt>Signed in as</dt><dd>{name}</dd></div>
        <div class="kv"><dt>You can</dt><dd>{yes.length ? yes.map((p) => p.label.toLowerCase()).join(", ") : "look at prices"}</dd></div>
        <div class="kv"><dt>Until</dt><dd>{expires ? day(expires) : "No end date"}</dd></div>
      </dl>
    </>
  );
}
