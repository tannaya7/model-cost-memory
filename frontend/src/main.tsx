import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { queryClient } from "./shared/api/queryClient";
import "./index.css";

// Mock server (MSW) is dev-only and opt-in: VITE_USE_MOCK=true npm run dev
async function start() {
  if (import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === "true") {
    const { worker } = await import("./mocks/browser");
    try {
      await worker.start();
    } catch (err) {
      // Still render the app, so each page shows a clear error instead of a blank screen.
      console.error("[MSW] Mock server failed to start. Restart with: VITE_USE_MOCK=true npm run dev", err);
    }
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

start();
