import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../../api/client";
import type { CalendarMe } from "./access";

/** The caller's Calendar access as the server sees it now. `denied` is a 403: no role, inactive, or revoked. */
export function useCalendarMe(): { me: CalendarMe | null; denied: boolean; error: string | null } {
  const [state, setState] = useState<{ me: CalendarMe | null; denied: boolean; error: string | null }>({ me: null, denied: false, error: null });
  const latest = useRef(0);
  useEffect(() => {
    const call = ++latest.current;
    apiFetch<CalendarMe>("/calendar/api/me").then(
      (me) => {
        if (call === latest.current) setState({ me, denied: false, error: null });
      },
      (caught: unknown) => {
        if (call !== latest.current) return;
        if (caught instanceof ApiError && caught.status === 403) setState({ me: null, denied: true, error: null });
        else setState({ me: null, denied: false, error: "Couldn't load your Calendar access." });
      },
    );
  }, []);
  return state;
}
