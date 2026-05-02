import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Connect } from "./Connect";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("No #root element");

createRoot(rootEl).render(
  <StrictMode>
    <Connect />
  </StrictMode>,
);
