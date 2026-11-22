import type { ChatMsg, Status } from "./twitch";
import { relayUrl } from "./relay";

export function parseKick(input: string): string | null {
  const m = input.trim().match(/kick\.com\/(?:popout\/)?([a-zA-Z0-9_-]{2,40})/i);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** Slug -> ids. Kick's channel API is usually browser-readable; otherwise ask the relay. */
export async function resolveKick(slug: string): Promise<{ channelId: number; chatroomId: number } | null> {
  const pick = (j: { id?: number; chatroom?: { id?: number }; channelId?: number | null; chatroomId?: number | null }) => {
    const channelId = j.channelId ?? j.id, chatroomId = j.chatroomId ?? j.chatroom?.id;
    return channelId && chatroomId ? { channelId, chatroomId } : null;
  };
  try { const r = await fetch(`https://kick.com/api/v2/channels/${slug}`); if (r.ok) { const x = pick(await r.json()); if (x) return x; } } catch { /* fall through */ }
  const r = await fetch(relayUrl(`/api/kick-resolve?slug=${encodeURIComponent(slug)}`));
  return r.ok ? pick(await r.json()) : null;
}

/** Read-only Kick chat relayed by our server as SSE, with watchdog + auto reconnect. */
export function connectKick(
  slug: string,
  chatroomId: number,
  channelId: number,
  keywords: string[],
  onMsg: (m: ChatMsg) => void,
  onStatus: (s: Status) => void,
) {
  let es: EventSource | null = null;
  let closed = false, attempt = 0, lastSeen = Date.now();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set<string>();

  const open = () => {
    onStatus(attempt ? "reconnecting" : "connecting");
    lastSeen = Date.now();
    es = new EventSource(relayUrl(`/api/kick-stream?chatroom=${chatroomId}&channel=${channelId}`));
    es.addEventListener("ka", () => { lastSeen = Date.now(); });
    es.addEventListener("live", () => { lastSeen = Date.now(); attempt = 0; onStatus("live"); });
    es.onmessage = (e) => {
      lastSeen = Date.now();
      try {
        const d = JSON.parse(e.data) as { id: string; u: string; c: string; t: string };
        if (seen.has(d.id)) return;
        seen.add(d.id); if (seen.size > 300) seen.delete(seen.values().next().value as string);
        const text = d.t.replace(/\[emote:\d+:([^\]]+)\]/g, ":$1:");
        const low = text.toLowerCase();
        onMsg({ p: "kick", id: `k${d.id}`, user: d.u, color: d.c, text, ts: Date.now(), mention: low.includes(`@${slug}`) || keywords.some((k) => low.includes(k)) });
      } catch { /* ignore */ }
    };
    es.onerror = () => { onStatus("reconnecting"); if (es?.readyState === EventSource.CLOSED) restart(); };
  };
  const kill = () => { es?.close(); es = null; };
  const restart = () => {
    kill(); clearTimeout(retry); attempt++;
    retry = setTimeout(open, Math.min(1000 * 2 ** attempt, 15000));
  };
  // Watchdog: server sends keep-alive every 15s; 45s of silence = frozen stream -> reconnect.
  const hb = setInterval(() => {
    if (es && Date.now() - lastSeen > 45000) { lastSeen = Date.now(); restart(); }
  }, 15000);
  const revive = () => {
    if (closed || document.visibilityState !== "visible") return;
    if (!es || es.readyState === EventSource.CLOSED || Date.now() - lastSeen > 30000) { kill(); attempt = 0; clearTimeout(retry); open(); }
  };
  document.addEventListener("visibilitychange", revive);
  window.addEventListener("online", revive);
  open();
  return () => {
    closed = true; clearInterval(hb); clearTimeout(retry);
    document.removeEventListener("visibilitychange", revive);
    window.removeEventListener("online", revive);
    kill(); onStatus("idle");
  };
}
