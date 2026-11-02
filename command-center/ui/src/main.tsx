import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { App } from "./App";
import { applyTheme } from "./chrome/ThemeSwitch";

applyTheme("auto"); // until /api/config answers; avoids a light flash in a dark OS
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
