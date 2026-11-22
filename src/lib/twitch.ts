export type Platform = "twitch" | "kick" | "youtube";
export type ChatMsg = { p: Platform; id: string; user: string; color: string; text: string; ts: number; mention: boolean };
export type Status = "idle" | "connecting" | "live" | "reconnecting";

/** Extract a Twitch channel name from a link or plain name. */
export function parseChannel(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/twitch\.tv\/(?:popout\/)?([a-zA-Z0-9_]{2,25})/i);
  const name = m ? m[1] : s.replace(/^#/, "");
  return name && /^[a-zA-Z0-9_]{2,25}$/.test(name) ? name.toLowerCase() : null;
}

function parseTags(raw: string) {
  const o: Record<string, string> = {};
  for (const kv of raw.split(";")) {
    const i = kv.indexOf("=");
    o[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return o;
}

/** Anonymous read-only Twitch chat with heartbeat watchdog + auto reconnect. */
export function connectTwitch(
  channel: string,
  keywords: string[],
  onMsg: (m: ChatMsg) => void,
  onStatus: (s: Status) => void,
) {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let lastSeen = Date.now();
  let hb: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    onStatus(attempt ? "reconnecting" : "connecting");
    ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    ws.onopen = () => {
      ws!.send("CAP REQ :twitch.tv/tags");
      ws!.send("PASS SCHMOOPIIE");
      ws!.send(`NICK justinfan${Math.floor(Math.random() * 90000) + 10000}`);
      ws!.send(`JOIN #${channel}`);
      lastSeen = Date.now();
    };
    ws.onmessage = (e) => {
      lastSeen = Date.now();
      for (const line of String(e.data).split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) { ws?.send("PONG :tmi.twitch.tv"); continue; }
        if (line.includes(" 366 ")) { attempt = 0; onStatus("live"); continue; }
        const m = line.match(/^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\S+ :(.*)$/);
        if (!m) continue;
        const tags = parseTags(m[1] ?? "");
        let text = m[3] ?? "";
        if (text.startsWith("\u0001ACTION ")) text = text.slice(8, -1);
        const low = text.toLowerCase();
        onMsg({
          p: "twitch",
          id: tags["id"] || `${Date.now()}${Math.random()}`,
          user: tags["display-name"] || m[2] || "?",
          color: tags["color"] || "",
          text,
          ts: Date.now(),
          mention: low.includes(`@${channel}`) || keywords.some((k) => k && low.includes(k)),
        });
      }
    };
    ws.onclose = () => { if (!closed) schedule(); };
    ws.onerror = () => ws?.close();
  };

  const schedule = () => {
    clearTimeout(retry);
    onStatus("reconnecting");
    attempt++;
    retry = setTimeout(open, Math.min(1000 * 2 ** attempt, 15000));
  };

  // Watchdog: ping every 30s; if silent >75s the socket is frozen -> reconnect.
  hb = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSeen > 75000) { ws.onclose = null; ws.close(); schedule(); return; }
    ws.send("PING :wd");
  }, 30000);

  // Phone woke up / network came back -> verify immediately.
  const revive = () => {
    if (closed) return;
    if (!ws || ws.readyState > 1 || Date.now() - lastSeen > 45000) {
      if (ws) { ws.onclose = null; ws.close(); }
      attempt = 0; clearTimeout(retry); open();
    }
  };
  document.addEventListener("visibilitychange", revive);
  window.addEventListener("online", revive);

  open();
  return () => {
    closed = true;
    clearInterval(hb); clearTimeout(retry);
    document.removeEventListener("visibilitychange", revive);
    window.removeEventListener("online", revive);
    if (ws) { ws.onclose = null; ws.close(); }
    onStatus("idle");
  };
}
