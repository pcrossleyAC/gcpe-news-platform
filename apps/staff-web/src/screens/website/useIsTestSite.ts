import { useEffect, useState } from "react";
import { apiFetch } from "../../api/client";

interface ConfigResponse {
  isTestSite?: boolean;
}

/**
 * `GET /nrms/api/config`'s `isTestSite` (Task 1) — Project Blue Bridge's panel shows a "This is
 * a TEST site" notice when it's true (task-5-brief.md). Fails safe the opposite way from the
 * time-zone hooks: a failed fetch leaves this `false` (no notice) rather than claiming a
 * production site is a test one, since the only harm from a missing notice on an actual test
 * site is a smaller one than wrongly scaring a real production editor.
 */
export function useIsTestSite(): boolean {
  const [isTestSite, setIsTestSite] = useState(false);

  useEffect(() => {
    let active = true;
    apiFetch<ConfigResponse>("/nrms/api/config").then(
      (config) => {
        if (active) setIsTestSite(config.isTestSite ?? false);
      },
      () => {
        // Keep the fallback (no notice).
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return isTestSite;
}
