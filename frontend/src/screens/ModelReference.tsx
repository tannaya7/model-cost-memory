/** Where a model's price and facts come from, in plain words: which number is the community list's and which is the maker's
 * own, when each was read, and links to the maker's own pages. Reference information only: no ranking, no benchmark, nothing
 * said about how a model performs on anyone's work. Unknown is shown as unknown.
 *
 * Everything tolerates a missing `reference` (an older answer): it then reads "not confirmed" and shows no link. */
import type { Model } from "../shared/api/types";
import { usd } from "../ui/format";
import { entryFor } from "./compare/profile/modelCatalog";

type Reference = Model["reference"];
export type ModelsMeta = {
  catalog?: { source: string; last_synced_at: string | null; note: string };
  official_sources?: Array<{ source_id: string; name: string; provider: string; url: string; status: string; last_checked_at: string | null; last_ok_at: string | null; stale: boolean }>;
  kind_note?: string;
};

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;

const SOURCE_STATE: Record<string, string> = { NEVER: "not read yet", OK: "read", UNREADABLE: "could not be read (its layout may have changed)", FETCH_FAILED: "could not be fetched" };

/** One line that says what the prices are and when they were last confirmed, from the catalog's source and the makers' pages. */
export function AsOfLine({ meta }: { meta: ModelsMeta | undefined }) {
  if (!meta?.catalog) return <p className="mt-1 text-sm text-dim" data-testid="as-of">What each model costs, which are being shut down, and where each number comes from.</p>;
  const synced = day(meta.catalog.last_synced_at);
  const sources = meta.official_sources ?? [];
  return (
    <p className="mt-1 max-w-3xl text-sm text-dim" data-testid="as-of">
      Prices come from the {meta.catalog.source}{synced ? `, last confirmed ${synced}` : ", not confirmed yet"}.{" "}
      {sources.length === 0
        ? "The makers' own pricing pages have not been read yet, so no price is confirmed against them."
        : `The makers' own pricing pages: ${sources.map((s) => `${s.provider === "anthropic" ? "Anthropic" : s.provider === "google" ? "Google" : s.provider === "openai" ? "OpenAI" : s.provider} ${s.status === "OK" && s.last_ok_at ? `read ${day(s.last_ok_at)}${s.stale ? " (older than 7 days)" : ""}` : SOURCE_STATE[s.status] ?? s.status}`).join("; ")}.`}
    </p>
  );
}

/** The explanation behind every price on the page, shown once and kept short. */
export function WhereFrom({ meta, basis }: { meta: ModelsMeta | undefined; basis?: string }) {
  return (
    <details className="mt-3 max-w-3xl text-xs text-muted" data-testid="where-from">
      <summary className="cursor-pointer font-semibold text-dim">Where this comes from, and what it is not</summary>
      <ul className="mt-2 list-disc space-y-1.5 pl-5">
        <li>{meta?.catalog?.note ?? "Prices come from a community-maintained list and refresh daily."}</li>
        <li>{basis ?? "List price in US dollars per million tokens, standard rate for text. Batch discounts, cached-input rates, long-context tiers and a price that changes on a date are not shown, so your bill can differ."}</li>
        <li>Everything here is what the makers publish. It is not how a model performs on your work: that is measured on Compare, from your own checked answers. No public benchmark is shown, and none predicts quality on your work.</li>
        <li>{meta?.kind_note ?? "This is a list of API models you can call. Coding tools and subscription apps, such as Cursor or Copilot, are not API endpoints, so they are not listed or ranked here."}</li>
        <li>Nothing here is sponsored, and no link earns anything. Links go to the makers' own pages.</li>
      </ul>
      {(meta?.official_sources?.length ?? 0) > 0 && (
        <ul className="mt-2 space-y-1" aria-label="The makers' pricing pages we read">
          {meta!.official_sources!.map((s) => (
            <li key={s.source_id}>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent hover:underline">{s.name} ↗</a>: {s.status === "OK" ? `read ${day(s.last_ok_at)}` : SOURCE_STATE[s.status] ?? s.status}
              {s.status !== "OK" && s.last_ok_at ? `. Last good reading ${day(s.last_ok_at)}` : ""}
              {s.stale ? ". This reading is more than 7 days old" : ""}.
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

const CHECK: Record<string, { label: (r: NonNullable<Reference>) => string; mark: string; tone: string }> = {
  confirmed: { label: () => "Matches the maker's page", mark: "✓", tone: "text-ok" },
  differs: {
    label: (r) => `The maker's page says ${r.official_input_per_mtok != null ? usd(r.official_input_per_mtok) : "?"} in, ${r.official_output_per_mtok != null ? usd(r.official_output_per_mtok) : "?"} out`,
    mark: "≠",
    tone: "text-warn",
  },
  not_readable: { label: () => "The maker's page gives no single price", mark: "?", tone: "text-muted" },
  not_listed: { label: () => "Not on the maker's pricing page", mark: "?", tone: "text-muted" },
  other_host: { label: () => "Sold by a partner; may differ from the maker's price", mark: "?", tone: "text-muted" },
  not_checked: { label: () => "Not confirmed against the maker's page", mark: "?", tone: "text-muted" },
};

/** The catalog price's check against the maker's own page, in words and a mark (never colour alone), with the date it was read. */
export function PriceCheck({ reference }: { reference: Reference | undefined }) {
  if (!reference) return <span className="text-xs text-muted">Not confirmed against the maker's page</span>;
  const c = CHECK[reference.price_check] ?? CHECK.not_checked;
  const when = day(reference.price_checked_at);
  return (
    <span className="flex flex-col gap-0.5 text-xs" data-testid="price-check" title={reference.price_check_note}>
      <span className={`font-semibold ${c.tone}`}>
        <span aria-hidden>{c.mark} </span>
        {c.label(reference)}
      </span>
      {when && reference.price_check !== "other_host" && <span className="text-muted">Read {when}{reference.price_check_stale ? ", more than 7 days ago" : ""}</span>}
    </span>
  );
}

/** Links to the maker's own pages for this model; none when we read none of that maker's pages. */
export function MakerLinks({ model, reference }: { model: string; reference: Reference | undefined }) {
  if (!reference || !reference.maker) return <span className="text-xs text-muted" data-testid="no-links">No official page linked</span>;
  const links = [
    ["Docs", reference.docs_url, "model docs"],
    ["Pricing", reference.pricing_url, "pricing"],
    ["Retirement", reference.deprecations_url, "retirement and deprecation"],
  ] as const;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {links.filter(([, url]) => url).map(([text, url, what]) => (
        <a key={text} href={url as string} target="_blank" rel="noopener noreferrer" aria-label={`${reference.maker}'s ${what} page for ${model} (opens in a new tab)`} className="font-semibold text-accent hover:underline">
          {text} ↗
        </a>
      ))}
    </span>
  );
}

/** What the maker's own page says the family is for, word for word, with the date it was read: an official claim, not a measurement. */
export function ProviderSays({ model }: { model: string }) {
  const e = entryFor(model);
  if (!e) return null;
  return (
    <span className="mt-0.5 block text-[11px] text-muted" data-testid="provider-says">
      {e.provider} says: “{e.providerSays}” (its own words, read {day(`${e.asOf}T00:00:00Z`)}). Not a measurement.
    </span>
  );
}
