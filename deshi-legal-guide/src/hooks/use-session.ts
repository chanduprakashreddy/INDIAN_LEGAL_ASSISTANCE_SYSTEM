import { useEffect, useState } from "react";

import { getSessionId } from "@/lib/session";

/** Anonymous per-browser session id, available after hydration. */
export function useSessionId(): string {
  const [sessionId, setSessionId] = useState("");
  useEffect(() => {
    setSessionId(getSessionId());
  }, []);
  return sessionId;
}
