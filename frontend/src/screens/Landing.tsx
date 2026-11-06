// The public landing page (D57): what mtg-intel is, shown with The Drop's own pieces, and the
// passkey sign-in. Nothing personal: the cards here are well-known public printings and every
// price on this page is an example, labelled as one.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useArtColour } from "../drop";
import { eur } from "../format";
import { Roll } from "../ui/Drop";
import { IconKey } from "../ui/icons";
import "./landing.css";

const ART = (id: string) => `https://cards.scryfall.io/art_crop/front/${id[0]}/${id[1]}/${id}.jpg`;
const CARD = (id: string) => `https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`;

/** Example drops for the hero: public cards, made-up prices (said on the page). */
const EXAMPLES = [
  { id: "881b6202-6d02-489b-b79c-62142c42ed1f", name: "Orcish Bowmasters", line: "Borderless · HOC 19 · English · NM", usual: 45.4, price: 27.2, tier: "Steal", cls: "t3", under: 40 },
  { id: "bdd2c783-1483-490a-ae93-c4664a0a9564", name: "The One Ring", line: "Borderless · HOC 44 · English · NM", usual: 113.6, price: 79.9, tier: "Great deal", cls: "t2", under: 30, gone: true },
  { id: "a71d1ec3-2d7a-4749-8936-8bf7a8b83d84", name: "Ragavan, Nimble Pilferer", line: "Borderless · FCA 43 · English · NM", usual: 31.6, price: 24.9, tier: "Good deal", cls: "t1", under: 21 },
  { id: "be326fe9-4ed8-4f64-934c-9955edea5fdb", name: "Atraxa, Grand Unifier", line: "Borderless · FCA 49 · English · NM", usual: 27.2, price: 21.5, tier: "Good deal", cls: "t1", under: 21 },
];
const STEP_MS = 4600;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The hero's live example: a drop arrives in its art's colour, its price rolls down from the
 *  usual price, the ring counts to the next check; now and then the copy sells and is stamped. */
function ExampleDrop() {
  const [i, setI] = useState(0);
  const [landed, setLanded] = useState(false);
  const ex = EXAMPLES[i % EXAMPLES.length];
  const colour = useArtColour(ART(ex.id));
  useEffect(() => {
    if (still()) { setLanded(true); return; }
    setLanded(false);
    const a = setTimeout(() => setLanded(true), 650);
    const b = setTimeout(() => setI((n) => n + 1), STEP_MS);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [i]);
  const [ring, setRing] = useState(0);
  useEffect(() => {
    if (still()) return;
    setRing(0);
    const t = setTimeout(() => setRing(1), 30);
    return () => clearTimeout(t);
  }, [i]);
  const c = 2 * Math.PI * 19;
  return (
    <figure class="ex" aria-label="An example deal">
      <div class="ex-drop drop" key={i} style={colour ? { "--f": colour } : undefined}>
        <div class="ex-art"><img src={ART(ex.id)} alt={`${ex.name}, card art`} /></div>
        <div class="ex-body">
          <h3>{ex.name}</h3>
          <div class="ex-price">
            <Roll value={landed ? ex.price : ex.usual} class="big" />
            <span class="d-ink">usual {eur(ex.usual)}<br />save {eur(ex.usual - ex.price)}</span>
          </div>
          <p class="d-ink">{ex.line}</p>
          <div class="ex-top">
            <span class={`tier ${ex.cls}`}>{ex.tier}<small>{ex.under}% under</small></span>
            <svg class="ring" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
              <circle class="track" cx="22" cy="22" r="19" fill="none" stroke-width="4" />
              <circle class="arc ex-arc" cx="22" cy="22" r="19" fill="none" stroke-width="4" stroke-dasharray={c}
                stroke-dashoffset={c * (1 - ring)} transform="rotate(-90 22 22)" style={{ transitionDuration: `${STEP_MS}ms` }} />
            </svg>
          </div>
        </div>
        {ex.gone && landed && <span class="stamp ex-stamp">Sold out</span>}
      </div>
      <figcaption>An example of how a deal shows up. Not a live price.</figcaption>
    </figure>
  );
}

function SignIn({ busy, onSignIn, local, big }: { busy: boolean; onSignIn: () => void; local: boolean; big?: boolean }) {
  if (local) return <a class={`btn primary${big ? " lg" : ""}`} href="https://mtg-intel.mtgintel-096633.workers.dev">Open my mtg-intel</a>;
  return <button class={`btn primary${big ? " lg" : ""}`} type="button" onClick={onSignIn} disabled={busy}><IconKey />{busy ? "Waiting…" : "Sign in with passkey"}</button>;
}

function Section({ id, title, lead, children, tone }: { id?: string; title: string; lead: string; children: ComponentChildren; tone?: string }) {
  return (
    <section id={id} class={`l-section${tone ? ` ${tone}` : ""}`}>
      <div class="l-copy">
        <h2>{title}</h2>
        <p>{lead}</p>
      </div>
      <div class="l-figure">{children}</div>
    </section>
  );
}

/** A slow ribbon of card art, each in its own colour field: the kind of printings it watches. */
const RIBBON = [
  { id: "881b6202-6d02-489b-b79c-62142c42ed1f", name: "Orcish Bowmasters" },
  { id: "bdd2c783-1483-490a-ae93-c4664a0a9564", name: "The One Ring" },
  { id: "a71d1ec3-2d7a-4749-8936-8bf7a8b83d84", name: "Ragavan, Nimble Pilferer" },
  { id: "bba5ea18-4e58-42a8-b613-2178706476a6", name: "Lightning Bolt" },
  { id: "be326fe9-4ed8-4f64-934c-9955edea5fdb", name: "Atraxa, Grand Unifier" },
  { id: "c68629ff-72b3-40a2-b578-cddb6ddb4ccf", name: "Sheoldred, the Apocalypse" },
];
function RibbonArt({ id, name }: { id: string; name: string }) {
  const colour = useArtColour(ART(id));
  return (
    <li style={colour ? { "--f": colour } : undefined}>
      <img src={ART(id)} alt={name} loading="lazy" />
      <span>{name}</span>
    </li>
  );
}
function Ribbon() {
  return (
    <section class="l-ribbon" aria-label="Printings like the ones it watches">
      <ul>{[...RIBBON, ...RIBBON].map((c, i) => <RibbonArt key={i} {...c} />)}</ul>
    </section>
  );
}

export function Landing({ busy, error, onSignIn, local, setupMissing }: {
  busy: boolean; error: string | null; onSignIn: () => void; local: boolean; setupMissing: boolean;
}) {
  const bolt = "bba5ea18-4e58-42a8-b613-2178706476a6";
  return (
    <div class="landing">
      <header class="l-bar">
        <a class="l-mark" href="/"><img src="/icon.svg" alt="" />mtg-intel</a>
        <nav>
          <a href="#how">How it works</a>
          <SignIn busy={busy} onSignIn={onSignIn} local={local} />
        </nav>
      </header>

      <section class="l-hero">
        <div class="l-hero-copy">
          <h1>Right card, right price.</h1>
          <p class="l-lead">mtg-intel watches the exact versions on a collector's want-list, checks CardTrader every ten minutes against Cardmarket, and calls out a copy the moment it drops well under its usual price.</p>
          <div class="l-acts">
            <SignIn busy={busy} onSignIn={onSignIn} local={local} big />
            <a class="btn lg" href="#how">How it works</a>
          </div>
          {error && <p class="err" role="alert">{error}</p>}
          {local ? <p class="l-note">This is Claude's local test copy, not your site.</p>
            : setupMissing ? <p class="l-note">Not set up yet: ask Claude for a setup link.</p>
            : <p class="l-note">Private: one collector, passkeys only. A new device joins with a setup link.</p>}
        </div>
        <ExampleDrop />
      </section>

      <Ribbon />

      <Section id="how" title="Only your version" lead="Not just the card: the set, the collector number, the language, the finish, the condition, and whether it ships via CardTrader Zero. A price is always for exactly that copy.">
        <div class="l-version">
          <img class="l-card" src={CARD(bolt)} alt="Lightning Bolt, borderless" loading="lazy" />
          <ul class="l-chips">
            <li><b>Version</b>Borderless</li>
            <li><b>Set and number</b>SLC 83</li>
            <li><b>Language</b>English</li>
            <li><b>Finish</b>Foil or not</li>
            <li><b>Condition</b>Near Mint or better</li>
            <li><b>Seller</b>Via CardTrader Zero</li>
          </ul>
        </div>
      </Section>

      <Section title="Two markets, one price" tone="flip" lead="CardTrader's cheapest fitting copy is checked every ten minutes and set beside Cardmarket's trend. The usual price is the higher of the two, so one odd listing can't fake a deal.">
        <div class="l-markets">
          <div class="l-market"><span class="l-dot ct" />CardTrader, cheapest copy<b class="fig">€27.20</b><small>checked 2 minutes ago</small></div>
          <div class="l-market"><span class="l-dot cm" />Cardmarket trend<b class="fig">€45.40</b><small>today's price guide</small></div>
          <div class="l-verdict"><span class="tier t3">Steal<small>40% under</small></span><p>A deal from 30% under its usual price, or 20% for cards usually over €20. Steals go up to 40% and beyond.</p></div>
          <p class="l-example">Example figures.</p>
        </div>
      </Section>

      <Section title="Waiting in your cart" lead="When a deal turns up, the copy goes into the CardTrader cart first, then a Telegram alert arrives with its picture. The alert keeps itself up to date until the deal ends.">
        <ol class="l-states">
          <li><span class="stamp still ok">In your cart</span><p>Checked again every ten minutes. Pay when you're ready.</p></li>
          <li><span class="stamp still ok">Bought</span><p>Your order is recorded and the card leaves the want-list.</p></li>
          <li><span class="stamp still">Sold out</span><p>Someone was faster. The alert says so; nothing to clean up.</p></li>
          <li><span class="stamp still">Deal ended</span><p>The price went back up, so the copy leaves the cart.</p></li>
        </ol>
      </Section>

      <footer class="l-close">
        <p class="l-big">mtg-intel</p>
        <div class="l-close-row">
          <SignIn busy={busy} onSignIn={onSignIn} local={local} big />
          <p class="l-legal">Card pictures and symbols via Scryfall. mtg-intel is unofficial Fan Content permitted under the Fan Content Policy. Not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.</p>
        </div>
      </footer>
    </div>
  );
}
