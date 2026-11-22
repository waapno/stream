// Static (GitHub Pages) entry: same chat console, no server. Kick + YouTube go through VITE_RELAY_URL.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatConsole } from "@/components/ChatConsole";
import "@/styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><ChatConsole /></StrictMode>);
