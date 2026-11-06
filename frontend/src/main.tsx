import { render } from "preact";
import { App } from "./app";
import { applyLook, readLook } from "./lab";
import "@fontsource-variable/archivo/wdth.css";
import "./styles.css";

applyLook(readLook());
render(<App />, document.getElementById("app")!);
