import { useEffect, useRef, useState } from "preact/hooks";

/** A card picture that fades in when loaded; foil cards carry a moving sheen. */
export function CardImage({ src, alt, foil, eager, name, placeholder }: {
  src: string | null; alt: string; foil?: boolean; eager?: boolean; name?: string; placeholder?: string | null;
}) {
  const [ready, setReady] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setReady(!!img.current?.complete && !!img.current?.naturalWidth);
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
          onLoad={() => setReady(true)}
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
      <CardImage src={src} alt={alt} eager name="card-open" placeholder={placeholder} />
    </div>
  );
}
