// Anonymous, per-browser session id. There is no sign-in: this id keeps one
// visitor's consultations, case files and documents separate from another's.

const STORAGE_KEY = "nyayasahay.session";

export function getSessionId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
