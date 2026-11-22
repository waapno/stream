import type { KeepAlive } from "./keepalive";
import type { Platform } from "./twitch";

export type AlertMode = "off" | "mentions" | "all";
export type SpeechMode = "off" | "mentions" | "all";
export type Link = { label: string; url: string };
/** Everything that's saved per channel preset. */
export type Prefs = {
  alert: AlertMode; speech: SpeechMode; speechVoice: string; vibrate: boolean; sound: boolean; big: boolean; keywords: string;
  shortcuts: Link[]; overlays: Link[]; showOverlays: boolean; keepAlive: KeepAlive;
};
export type Profile = { id: string; name: string; chats: string[]; prefs: Prefs };
export type State = { active: string | null; profiles: Profile[]; relay: string };

export const DEFAULT_PREFS: Prefs = {
  alert: "mentions", speech: "off", speechVoice: "", vibrate: true, sound: true, big: true, keywords: "",
  shortcuts: [
    { label: "OBS Blade", url: "intent://#Intent;package=com.kounex.obs_blade;end" },
    { label: "Kick", url: "https://dashboard.kick.com" },
  ],
  overlays: [], showOverlays: false, keepAlive: "tab",
};
export const EMPTY: State = { active: null, profiles: [], relay: "" };
export const STORE = "scc.state.v2";
const LEGACY = "scc.cfg.v1";

/** Chat key: "twitch:name" | "kick:slug:chatroomId:channelId" | "youtube:@handle|videoId". */
export function decode(key: string): { p: Platform; name: string; room: number; cid: number } {
  const [a, b = "", c, d] = key.split(":");
  if (a === "kick") return { p: "kick", name: b, room: Number(c), cid: Number(d ?? c) };
  if (a === "youtube") return { p: "youtube", name: key.slice(8), room: 0, cid: 0 };
  if (a === "twitch") return { p: "twitch", name: b, room: 0, cid: 0 };
  return { p: "twitch", name: key, room: 0, cid: 0 };
}
export const PLATFORM_LABEL: Record<Platform, string> = { twitch: "Twitch", kick: "Kick", youtube: "YouTube" };

const uid = () => Math.random().toString(36).slice(2, 10);
export const newProfile = (name: string, chats: string[], prefs: Prefs = DEFAULT_PREFS): Profile =>
  ({ id: uid(), name, chats, prefs: structuredClone(prefs) });

/** Load saved state; converts the old single-config format (one preset per saved channel). */
export function load(get: (k: string) => string | null): State {
  try {
    const s = get(STORE);
    if (s) {
      const j = JSON.parse(s) as State;
      return { ...EMPTY, ...j, profiles: (j.profiles ?? []).map((p) => ({ ...p, prefs: { ...DEFAULT_PREFS, ...p.prefs } })) };
    }
    const old = get(LEGACY);
    if (old) {
      const o = JSON.parse(old) as Partial<Prefs> & { channel?: string; saved?: string[] };
      const prefs: Prefs = { ...DEFAULT_PREFS };
      for (const k of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) if (o[k] !== undefined) (prefs as Record<string, unknown>)[k] = o[k];
      const keys = [...new Set([...(o.channel ? [o.channel] : []), ...(o.saved ?? [])])];
      const profiles = keys.map((k) => newProfile(decode(k).name, [k], prefs));
      return { active: profiles[0]?.id ?? null, profiles, relay: "" };
    }
  } catch { /* corrupted storage -> start clean */ }
  return EMPTY;
}
