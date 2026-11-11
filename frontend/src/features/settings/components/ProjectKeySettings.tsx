import { useState } from "react";
import { apiFetch, ApiError, getApiKey, setApiKey } from "../../../shared/api/apiFetch";
import { queryClient } from "../../../shared/api/queryClient";
import { Card } from "../../../shared/components/Card";
import type { Job } from "../../../shared/api/types";

function maskKey(key: string): string {
  if (!key) return "None";
  if (key.length <= 8) return `${key}••••`;
  return `${key.slice(0, 8)}••••••••`;
}

export function ProjectKeySettings() {
  const [currentKey, setCurrentKey] = useState<string>(() => getApiKey());
  const [showKey, setShowKey] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [copyFailed, setCopyFailed] = useState<boolean>(false);
  const [inputKey, setInputKey] = useState<string>("");
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleCopy() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(currentKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback if clipboard API is restricted
      try {
        const textarea = document.createElement("textarea");
        textarea.value = currentKey;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setCopyFailed(true);
      }
    }
  }

  async function handleCheckAndSave(e: React.FormEvent) {
    e.preventDefault();
    const keyToTest = inputKey.trim();
    if (!keyToTest) return;

    setIsChecking(true);
    setMessage(null);

    try {
      // Test key by calling GET /v1/jobs with that key in X-API-Key before saving
      await apiFetch<Job[]>("/v1/jobs", {
        headers: { "X-API-Key": keyToTest },
      });

      // Success
      setApiKey(keyToTest);
      setCurrentKey(keyToTest);
      setInputKey("");
      queryClient.clear();
      setMessage({ type: "success", text: "Key saved" });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        setMessage({
          type: "error",
          text: "That key was not accepted. Check it and try again.",
        });
      } else if (err instanceof ApiError) {
        setMessage({
          type: "error",
          text: err.message || `Request failed (${err.status})`,
        });
      } else if (err instanceof Error) {
        setMessage({ type: "error", text: err.message });
      } else {
        setMessage({ type: "error", text: "An unexpected error occurred while checking key." });
      }
    } finally {
      setIsChecking(false);
    }
  }

  function handleResetDemo() {
    const demoKey = "demo-key";
    setApiKey(demoKey);
    setCurrentKey(demoKey);
    setInputKey("");
    setShowKey(false);
    queryClient.clear();
    setMessage({ type: "success", text: "Reset to demo key" });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">Project API Key</h2>
            <p className="mt-1 text-sm text-dim">
              This key authenticates requests to the Model &amp; Cost Memory API (sent as the{" "}
              <code className="rounded bg-skeleton px-1.5 py-0.5 font-mono text-xs text-ink">X-API-Key</code> header).
            </p>
          </div>

          {/* Key in use with Mask, Show/Hide, and Copy */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-bg p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="text-dim shrink-0">Key in use:</span>
              <code className="rounded bg-surface px-2.5 py-1 font-mono text-xs font-semibold text-ink border border-rule break-all">
                {showKey ? currentKey : maskKey(currentKey)}
              </code>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                aria-label={showKey ? "Hide project key" : "Show project key"}
                className="rounded-md border border-rule bg-surface px-2.5 py-1 text-xs font-medium text-dim hover:bg-bg hover:text-ink focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
              >
                {showKey ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy project key"
                className="rounded-md border border-rule bg-surface px-2.5 py-1 text-xs font-medium text-dim hover:bg-bg hover:text-ink focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          {copyFailed && (
            <p role="alert" className="text-xs text-bad">
              Couldn't copy. Select the key and copy it by hand.
            </p>
          )}

          <form onSubmit={handleCheckAndSave} className="space-y-4 pt-2">
            <div>
              <label htmlFor="apiKeyInput" className="block text-sm font-medium mb-1">
                New Project Key
              </label>
              <input
                id="apiKeyInput"
                type="text"
                autoComplete="off"
                placeholder="mcm_live_..."
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
                className="w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>

            {message && (
              <div
                role="alert"
                className={`rounded-md p-3 text-sm font-medium ${
                  message.type === "success"
                    ? "border border-ok bg-ok-soft text-ok"
                    : "border border-bad bg-bad-soft text-bad"
                }`}
              >
                {message.text}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={isChecking || !inputKey.trim()}
                className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isChecking ? "Checking..." : "Check and save"}
              </button>
              <button
                type="button"
                onClick={handleResetDemo}
                className="rounded-md border border-rule bg-surface px-3 py-2 text-sm font-medium text-dim hover:bg-bg hover:text-ink"
              >
                Reset to demo key
              </button>
            </div>
          </form>
        </div>
      </Card>
    </div>
  );
}
