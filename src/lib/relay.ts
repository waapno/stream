/**
 * Base URL of the server that relays Kick + YouTube chat (browsers can't reach them directly).
 * Empty = same origin (hosted app). The static GitHub Pages build sets VITE_RELAY_URL,
 * and the user can override it in settings.
 */
let override = "";
export const setRelay = (url: string) => { override = url.trim().replace(/\/+$/, ""); };
export const relayBase = () => override || String(import.meta.env["VITE_RELAY_URL"] ?? "").replace(/\/+$/, "");
export const relayUrl = (path: string) => `${relayBase()}${path}`;
