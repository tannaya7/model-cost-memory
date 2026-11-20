import { useState, type FormEvent } from "react";
import { Card } from "../../../shared/components/Card";
import { useToast } from "../../../ui/Toast";
import { useSaveProviderKey } from "../hooks/useRetest";

const PROVIDERS = [
  { id: "gemini", label: "Google Gemini" },
  { id: "groq", label: "Groq" },
  { id: "openai", label: "OpenAI" },
  { id: "other", label: "Other (OpenAI-compatible)" },
];

/** Asked for the first time a re-test needs it, never at project creation. */
export function ProviderKeyForm({ onSaved }: { onSaved: () => void }) {
  const save = useSaveProviderKey();
  const toast = useToast();
  const [provider, setProvider] = useState("gemini");
  const [customName, setCustomName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const isOther = provider === "other";
  const canSave = apiKey.trim().length >= 8 && (!isOther || (customName.trim() && baseUrl.startsWith("http")));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    try {
      await save.mutateAsync({
        provider: isOther ? customName.trim().toLowerCase() : provider,
        api_key: apiKey.trim(),
        base_url: isOther ? baseUrl.trim() : null,
      });
    } catch {
      return; // the error shows under the form and the pasted key stays
    }
    setApiKey("");
    toast({ message: "Provider key saved" });
    onSaved();
  }

  const field =
    "w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <Card className="space-y-4 border-accent/40 p-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Add the key trials on new models should use</h2>
        <p className="mt-1 text-xs text-dim">
          It stays under the monthly budget above. Stored encrypted; only the last 4 characters show. Remove it any time.
        </p>
        <details className="mt-1 text-xs text-dim">
          <summary className="cursor-pointer font-semibold text-accent">How trials use this key</summary>
          <p className="mt-1">
            A trial replays your past prompts on another model to see if it does as well. It uses your own provider key, so the spending is yours. Saving the key does not start anything. You choose each trial, review what it will send and roughly what it will cost, and confirm it first. Only models with a known price are tried, and the cost is estimated at list prices, so check your provider's own bill.
          </p>
        </details>
      </div>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-ink">
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className={`mt-1 ${field}`}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink">
          API key
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste the key"
            className={`mt-1 ${field}`}
          />
        </label>
        {isOther && (
          <>
            <label className="text-sm text-ink">
              Provider name (as in the model catalog)
              <input value={customName} onChange={(e) => setCustomName(e.target.value)} className={`mt-1 ${field}`} />
            </label>
            <label className="text-sm text-ink">
              Base URL
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://.../v1"
                className={`mt-1 ${field}`}
              />
            </label>
          </>
        )}
        {save.isError && (
          <p role="alert" className="text-sm text-bad sm:col-span-2">
            {save.error instanceof Error ? save.error.message : "Could not save the key."}
          </p>
        )}
        <div className="sm:col-span-2 flex justify-end">
          <button
            type="submit"
            disabled={!canSave || save.isPending}
            className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save key"}
          </button>
        </div>
      </form>
    </Card>
  );
}
