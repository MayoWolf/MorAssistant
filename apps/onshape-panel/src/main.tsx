import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const launchTheme = new URLSearchParams(location.hash.slice(1)).get("theme")
  ?? new URLSearchParams(location.search).get("theme");
document.documentElement.dataset.theme = launchTheme === "light" || launchTheme === "dark"
  ? launchTheme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>
);
