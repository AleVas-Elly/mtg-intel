import { render } from "preact";
import { App } from "./app";
import { applyLook, readLook } from "./lab";
import { registerWorker } from "./notify";
import { go } from "./router";
import "@fontsource-variable/archivo/wdth.css";
import "./styles.css";

applyLook(readLook());
render(<App />, document.getElementById("app")!);
registerWorker();
// a tapped notification asks the open app to show its page when the browser can't navigate the tab
navigator.serviceWorker?.addEventListener("message", (e) => {
  const open = (e.data as { open?: string } | null)?.open;
  if (open) { const u = new URL(open); go(u.pathname, u.searchParams.get("card")); }
});
