/** A download button for a CSV the server builds, and a plain note about what was in the file.
 *
 *  The server decides who may export, which rows and which period, and neutralizes text a spreadsheet could run as a formula; the
 *  button only asks, saves the file and says what happened. It never builds a file from screen data, so a file cannot hold more than
 *  the person is allowed to export. */
import { useState, type ReactNode } from "react";
import { apiDownload, type Download } from "../../shared/api/apiFetch";
import { Button } from "../../ui/primitives";
import { IconDownload } from "../../ui/icons";

/** One or two plain sentences about the file just saved. The second explains the apostrophes, only when there were any. */
export function exportNote(rows: number, neutralized: number, what: string): string {
  const first = rows === 0 ? `The file has no rows for ${what}, only its column names.` : `Saved ${rows.toLocaleString("en")} ${rows === 1 ? "row" : "rows"} for ${what}.`;
  const second = " Each row says its period, units and how the cost was worked out. It holds counts, tokens and cost only, never prompts, answers or keys.";
  if (neutralized === 0) return first + second;
  const many = neutralized === 1 ? "1 text value began" : `${neutralized.toLocaleString("en")} text values began`;
  return `${first}${second} ${many} with = + - or @, which a spreadsheet can run as a formula, so a ' was added in front of ${neutralized === 1 ? "it" : "each"}. Numbers were not changed.`;
}

export function saveBlob(file: Download): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportButton({ path, what, title, disabled, children }: { path: string; what: string; title?: string; disabled?: boolean; children?: ReactNode }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; note: string } | { kind: "error"; message: string }>({ kind: "idle" });
  const run = async () => {
    setState({ kind: "busy" });
    try {
      const file = await apiDownload(path);
      saveBlob(file);
      setState({ kind: "done", note: exportNote(file.rows, file.neutralized, what) });
    } catch (e) {
      const status = (e as { status?: number }).status;
      const reason = e instanceof Error ? e.message : "Something went wrong";
      setState({ kind: "error", message: status === 403 ? `Your role does not allow this: ${reason}` : `Could not make the file: ${reason}` });
    }
  };
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button variant="primary" onClick={run} disabled={disabled || state.kind === "busy"} title={title}>
        <IconDownload size={16} /> {state.kind === "busy" ? "Preparing the file…" : children ?? "Export"}
      </Button>
      <div role="status" aria-live="polite" className="max-w-sm text-right text-xs text-dim">
        {state.kind === "done" && state.note}
        {state.kind === "error" && <span className="text-bad">{state.message}</span>}
      </div>
    </div>
  );
}
