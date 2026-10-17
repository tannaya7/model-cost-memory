import { useState } from "react";
import { setApiKey } from "../../../shared/api/apiFetch";
import { queryClient } from "../../../shared/api/queryClient";

interface ApiKeyRevealBoxProps {
  apiKey: string;
  title?: string;
  onDismiss?: () => void;
}

export function ApiKeyRevealBox({
  apiKey,
  title = "Copy this key now. You won't see it again.",
  onDismiss,
}: ApiKeyRevealBoxProps) {
  const [copied, setCopied] = useState(false);
  const [usedInApp, setUsedInApp] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = apiKey;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        /* ignore */
      }
    }
  };

  const handleUseInApp = () => {
    setApiKey(apiKey);
    queryClient.clear();
    setUsedInApp(true);
    setTimeout(() => setUsedInApp(false), 3000);
  };

  return (
    <div
      role="alert"
      className="rounded-card border border-accent/40 bg-accent-soft p-5 space-y-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-ink">{title}</h4>
          <p className="mt-0.5 text-xs text-dim">
            This API key authenticates your backend or SDK calls to Model &amp;
            Cost Memory. Store it securely in your environment variables.
          </p>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded px-2 py-1 text-xs font-medium text-dim hover:bg-bg hover:text-ink"
          >
            Dismiss
          </button>
        )}
      </div>

      <div className="rounded-md border border-rule bg-surface p-3 font-mono text-xs text-ink break-all select-all flex items-center justify-between gap-3">
        <span>{apiKey}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleCopy}
          className="rounded-md bg-surface border border-rule px-3.5 py-1.5 text-xs font-semibold text-ink shadow-sm hover:bg-bg"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
        <button
          type="button"
          onClick={handleUseInApp}
          className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-on-accent shadow-sm hover:opacity-90"
        >
          {usedInApp ? "Active key updated!" : "Use this key in the app"}
        </button>
      </div>
    </div>
  );
}
