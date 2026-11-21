/** Decides when the tour shows: by itself once, for a new empty project, or whenever "Take the tour again" is chosen. */
import { useState } from "react";
import { useProject } from "../../app/project";
import { useDaily } from "../insights/api/dailyApi";
import { Tour } from "./Tour";
import { shouldAutoStartTour } from "./steps";
import { useGuideFlags } from "./useGuideFlags";

export function TourHost({ replay, onReplayDone }: { replay: boolean; onReplayDone: () => void }) {
  const { mode } = useProject();
  const { loaded, flags, set } = useGuideFlags();
  const [closed, setClosed] = useState(false);
  const daily = useDaily({ days: 90 });
  const auto =
    !closed &&
    shouldAutoStartTour({
      flagsLoaded: loaded,
      flags,
      owned: mode === "owned",
      dataLoaded: daily.isSuccess,
      totalRuns: (daily.data ?? []).reduce((s, d) => s + (d.runs ?? 0), 0),
    });
  return (
    <Tour
      open={replay || auto}
      onClose={() => {
        setClosed(true);
        set("tour_seen", true);
        onReplayDone();
      }}
    />
  );
}
