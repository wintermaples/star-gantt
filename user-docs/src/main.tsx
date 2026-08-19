import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, storedTheme } from "./lib/theme";
import "./styles.css";

// Before the first render, so a reader who chose a scheme last visit never sees the other one.
applyTheme(storedTheme());

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
