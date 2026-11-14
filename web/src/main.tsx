import * as React from "react";
import { createRoot } from "react-dom/client";
import { Tooltip } from "radix-ui";
import "./globals.css";
import { App } from "./app/app";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Tooltip.Provider>
      <App />
    </Tooltip.Provider>
  </React.StrictMode>,
);

// The service worker only in a build: in development it would cache over Vite's live modules.
if ("serviceWorker" in navigator && import.meta.env.PROD) void navigator.serviceWorker.register("/sw.js");
