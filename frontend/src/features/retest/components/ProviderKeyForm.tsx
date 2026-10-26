import { useState, type FormEvent } from "react";
import { Card } from "../../../shared/components/Card";
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
  const [provider, setProvider] = useState("gemini");
  const [customName, setCustomName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const isOther = provider === "other";
  const canSave = apiKey.trim().length >= 8 && (!isOther || (customName.trim() && baseUrl.startsWith("http")));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    await save.mutateAsync({
      provider: isOther ? customName.trim().toLowerCase() : provider,
      api_key: apiKey.trim(),
      base_url: isOther ? baseUrl.trim() : null,
    });
    setApiKey("");
    onSaved();
  }

  const field =
    "w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <Card className="space-y-4 border-accent/40 p-6">
      <div>
        <h3 className="text-base font-semibold text-ink">Add the key re-tests should use</h3>
        <p className="mt-1 text-xs text-dim">
          Re-tests call the candidate model with your own provider key, so the spending is yours and stays
          under the monthly cap above. Saving the key is your permission for re-tests to run within that cap,
          including ones the system starts when a cheaper model appears. The key is encrypted on the server and
          only its last four characters are ever shown again. You can remove it at any time.
        </p>
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
