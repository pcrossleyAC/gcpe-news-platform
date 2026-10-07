import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../../api/client";

/** GETs `url` whenever it changes (null: nothing to load). Only the latest request may land, so a
 * slow earlier page can't overwrite a newer one. */
export function useReport<T>(url: string | null): { data: T | null; error: unknown } {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: unknown }>({ url: null, data: null, error: null });
  const latest = useRef(0);
  useEffect(() => {
    if (!url) return;
    const seq = ++latest.current;
    apiFetch<T>(url).then(
      (data) => {
        if (seq === latest.current) setState({ url, data, error: null });
      },
      (error: unknown) => {
        if (seq === latest.current) setState({ url, data: null, error });
      },
    );
  }, [url]);
  return state.url === url ? { data: state.data, error: state.error } : { data: null, error: null };
}
