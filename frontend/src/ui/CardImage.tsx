import { useEffect, useRef, useState } from "preact/hooks";

// Pictures already loaded in this page: they show at once, so a view transition snapshot holds the
// real picture rather than the blurry placeholder.
const loaded = new Set<string>();

/** Load and decode a picture, giving up after `ms`. */
const pending = new Map<string, Promise<void>>();
export function preloadImage(src: string | null | undefined, ms: number): Promise<void> {
  if (!src || loaded.has(src)) return Promise.resolve();
  let done = pending.get(src);
  if (!done) {
    const img = new Image();
    img.src = src;
    done = img.decode().then(() => { loaded.add(src); }, () => {}).finally(() => pending.delete(src));
    pending.set(src, done);
  }
  return Promise.race([done, new Promise<void>((r) => setTimeout(r, ms))]);
}

/** A card picture that fades in when loaded; foil cards carry a moving sheen. */
export function CardImage({ src, alt, foil, eager, name, placeholder }: {
  src: string | null; alt: string; foil?: boolean; eager?: boolean; name?: string; placeholder?: string | null;
}) {
  const [ready, setReady] = useState(() => !!src && loaded.has(src));
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setReady((!!src && loaded.has(src)) || (!!img.current?.complete && !!img.current?.naturalWidth));
  }, [src]);
  return (
    <div class={`thumb${foil ? " foil" : ""}`}
      style={{ ...(name ? { viewTransitionName: name } : {}), ...(placeholder ? { backgroundImage: `url(${placeholder})`, backgroundSize: "cover" } : {}) }}>
      {src && (
        <img
          ref={img}
          src={src}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          class={ready ? "ready" : ""}
          onLoad={() => { loaded.add(src); setReady(true); }}
        />
      )}
    </div>
  );
}

/** The big card in the detail view: tilts toward the pointer, and the foil sheen follows it. */
export function BigCard({ src, alt, foil, placeholder }: { src: string | null; alt: string; foil: boolean; placeholder?: string | null }) {
  const el = useRef<HTMLDivElement>(null);
  const move = (e: PointerEvent) => {
    const box = el.current!.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    el.current!.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 9}deg) rotateY(${(x - 0.5) * 11}deg)`;
    el.current!.style.setProperty("--fx", `${x * 100}%`);
    el.current!.style.setProperty("--fy", `${y * 100}%`);
  };
  const leave = () => {
    el.current!.style.transform = "";
  };
  return (
    <div ref={el} class={`card-big${foil ? " foil" : ""}`} onPointerMove={move} onPointerLeave={leave}>
      <CardImage src={src} alt={alt} eager placeholder={placeholder} />
    </div>
  );
}
