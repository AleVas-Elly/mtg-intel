import { render } from "preact";
import { App } from "./app";
import { applyLook, readLook } from "./lab";
import "./styles.css";

applyLook(readLook());
render(<App />, document.getElementById("app")!);
