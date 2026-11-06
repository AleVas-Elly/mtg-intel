import { useEffect } from "preact/hooks";

/** A small question before something hard to take back. */
export function Confirm({ title, text, action, onCancel, onConfirm }: {
  title: string; text: string; action: string; onCancel: () => void; onConfirm: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  return (
    <div class="sheet-wrap center" role="presentation" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div class="confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{text}</p>
        <div class="confirm-actions">
          <button class="btn" type="button" onClick={onCancel} autoFocus>Cancel</button>
          <button class="btn danger" type="button" onClick={onConfirm}>{action}</button>
        </div>
      </div>
    </div>
  );
}
