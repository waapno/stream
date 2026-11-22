import type { ChatMsg, Status } from "./twitch";
import { relayUrl } from "./relay";

/** "@handle", channel id (UC…), or 11-char video id from any YouTube link / plain input. */
export function parseYouTube(input: string): string | null {
  const s = input.trim();
  const v = s.match(/(?:youtu\.be\/|[?&]v=|\/live\/|\/shorts\/)([\w-]{11})/);
  if (v?.[1]) return v[1];
  const h = s.match(/youtube\.com\/(@[\w.-]{2,60})/i) ?? s.match(/^(@[\w.-]{2,60})$/);
  if (h?.[1]) return h[1];
  const c = s.match(/youtube\.com\/channel\/(UC[\w-]{22})/i) ?? s.match(/^(UC[\w-]{22})$/);
  return c?.[1] ?? null;
}

type Init = { v?: string; k?: string; ver?: string; c?: string; offline?: boolean; error?: string };
type Poll = { c?: string | null; msgs?: { id: string; u: string; t: string; paid: boolean }[]; wait?: number; ended?: boolean; error?: string };

/** Polls the relay. Offline channel = keep checking every 30s, so it picks up when the stream starts. */
export function connectYouTube(src: string, keywords: string[], onMsg: (m: ChatMsg) => void, onStatus: (s: Status) => void) {
  let closed = false, attempt = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let sess: { k: string; ver: string; c: string } | null = null;
  const seen = new Set<string>();
  const later = (ms: number) => { clearTimeout(timer); if (!closed) timer = setTimeout(tick, ms); };

  const tick = async () => {
    try {
      if (!sess) {
        onStatus(attempt ? "reconnecting" : "connecting");
        const d = (await (await fetch(relayUrl(`/api/yt-chat?src=${encodeURIComponent(src)}`))).json()) as Init;
        if (closed) return;
        if (d.k && d.ver && d.c) { sess = { k: d.k, ver: d.ver, c: d.c }; attempt = 0; onStatus("live"); return later(300); }
        attempt++; onStatus("reconnecting"); return later(d.offline ? 30000 : Math.min(2000 * 2 ** attempt, 30000));
      }
      const q = new URLSearchParams({ c: sess.c, k: sess.k, ver: sess.ver });
      const d = (await (await fetch(relayUrl(`/api/yt-chat?${q}`))).json()) as Poll;
      if (closed) return;
      if (!d.c) { sess = null; attempt++; return later(3000); }
      sess.c = d.c;
      for (const m of d.msgs ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id); if (seen.size > 500) seen.delete(seen.values().next().value as string);
        const low = m.t.toLowerCase();
        onMsg({ p: "youtube", id: `y${m.id}`, user: m.u, color: "", text: m.t, ts: Date.now(), mention: m.paid || keywords.some((k) => low.includes(k)) });
      }
      onStatus("live");
      later(Math.min(d.wait ?? 3000, 3000));
    } catch {
      if (closed) return;
      attempt++; onStatus("reconnecting"); later(Math.min(2000 * 2 ** attempt, 20000));
    }
  };
  const revive = () => { if (!closed && document.visibilityState === "visible") later(0); };
  document.addEventListener("visibilitychange", revive);
  window.addEventListener("online", revive);
  tick();
  return () => {
    closed = true; clearTimeout(timer);
    document.removeEventListener("visibilitychange", revive);
    window.removeEventListener("online", revive);
    onStatus("idle");
  };
}
