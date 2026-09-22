import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useStore } from "./lib/store";
import { cardPngBase64, renderCard } from "./lib/cardRender";

if (import.meta.env.DEV) {
  // Dev hook so the card pipeline can be exercised from outside the app.
  (window as unknown as Record<string, unknown>).__editor360 = { useStore, cardPngBase64, renderCard };
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
