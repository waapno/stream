import { createFileRoute } from "@tanstack/react-router";

// Kick's realtime socket rejects browser origins, so the server relays chat as SSE.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const KH = { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json", Origin: "https://kick.com", "x-app-platform": "web" };

type Sock = { send(d: string): void; close(): void; addEventListener(t: string, f: (e: { data?: unknown }) => void): void };

async function openUpstream(url: string): Promise<Sock> {
  const g = globalThis as unknown as { WebSocketPair?: unknown; WebSocket: new (u: string, o?: unknown) => Sock & { readyState: number } };
  if (g.WebSocketPair) {
    // Cloudflare Workers: outbound websocket via fetch upgrade (allows custom Origin).
    const r = (await fetch(url.replace(/^wss:/, "https:"), { headers: { ...KH, Upgrade: "websocket" } })) as Response & { webSocket?: Sock & { accept(): void } };
    if (!r.webSocket) throw new Error(`upgrade failed ${r.status}`);
    r.webSocket.accept();
    return r.webSocket;
  }
  // Node (dev server): undici WebSocket accepts headers.
  const ws = new g.WebSocket(url, { headers: { Origin: "https://kick.com", "User-Agent": UA } });
  await new Promise<void>((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", () => rej(new Error("ws error"))); });
  return ws;
}

export const Route = createFileRoute("/api/kick-stream")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const q = new URL(request.url).searchParams;
        const chatroom = Number(q.get("chatroom")), channel = Number(q.get("channel"));
        if (!Number.isInteger(chatroom) || !Number.isInteger(channel) || chatroom <= 0 || channel <= 0) return new Response("bad params", { status: 400, headers: { "Access-Control-Allow-Origin": "*" } });

        const clientId = crypto.randomUUID();
        const neg = await fetch(`https://web.kick.com/api/v1/realtime/channels/${channel}/chat/connection`, {
          method: "POST", headers: KH,
          body: JSON.stringify({ client: { id: clientId, type: "web" }, capabilities: { accepted_providers: [{ provider: "centrifugo" }] } }),
        });
        const nj = (await neg.json().catch(() => ({}))) as { data?: { connections?: { provider: string; credentials?: { url?: string } }[] } };
        const wsUrl = nj.data?.connections?.find((c) => c.provider === "centrifugo")?.credentials?.url;
        const aj = (await (await fetch("https://web.kick.com/api/v1/realtime/auth/connection", { method: "POST", headers: KH, body: JSON.stringify({ client_id: clientId }) })).json().catch(() => ({}))) as { data?: { token?: string } };
        const token = aj.data?.token;
        if (!wsUrl || !/^wss:\/\/[a-z0-9.-]+\.kick\.com\//.test(wsUrl) || !token) return new Response("kick unavailable", { status: 502 });

        let up: Sock;
        try { up = await openUpstream(wsUrl); } catch { return new Response("kick socket failed", { status: 502 }); }

        const enc = new TextEncoder();
        let done = false;
        const stream = new ReadableStream<Uint8Array>({
          start(ctl) {
            const out = (s: string) => { if (!done) try { ctl.enqueue(enc.encode(s)); } catch { finish(); } };
            const ka = setInterval(() => out("event: ka\ndata: 1\n\n"), 15000);
            let ttlTimer: ReturnType<typeof setTimeout> | undefined;
            const finish = () => {
              if (done) return; done = true;
              clearInterval(ka); clearTimeout(ttlTimer);
              try { up.close(); } catch { /* ignore */ }
              try { ctl.close(); } catch { /* ignore */ }
            };
            request.signal.addEventListener("abort", finish);
            out("retry: 2000\n\n");
            up.addEventListener("close", finish);
            up.addEventListener("error", finish);
            up.addEventListener("message", (e) => {
              for (const line of String(e.data).split("\n")) {
                if (!line.trim()) continue;
                let item: Record<string, unknown>;
                try { item = JSON.parse(line); } catch { continue; }
                if (Object.keys(item).length === 0) { up.send("{}"); continue; }
                if (item["id"] === 1) {
                  const c = item["connect"] as { ttl?: number } | undefined;
                  if (!c) { finish(); return; }
                  if (c.ttl) ttlTimer = setTimeout(finish, c.ttl * 900); // client reconnects with a fresh token
                  up.send(JSON.stringify({ id: 2, subscribe: { channel: `chatrooms.${chatroom}.v2` } }));
                  continue;
                }
                if (item["id"] === 2) { if (item["error"]) finish(); else out("event: live\ndata: 1\n\n"); continue; }
                const push = item["push"] as { pub?: { data?: unknown }; disconnect?: unknown } | undefined;
                if (!push) continue;
                if (push.disconnect) { finish(); return; }
                let ev = push.pub?.data as { event?: string; data?: unknown } | string | undefined;
                if (typeof ev === "string") try { ev = JSON.parse(ev); } catch { continue; }
                if (!ev || typeof ev !== "object" || ev.event !== "App\\Events\\ChatMessageEvent") continue;
                let d = ev.data as { id?: string; content?: string; sender?: { username?: string; identity?: { color?: string } } } | string;
                if (typeof d === "string") try { d = JSON.parse(d); } catch { continue; }
                if (typeof d !== "object" || !d.content) continue;
                out(`data: ${JSON.stringify({ id: d.id, u: d.sender?.username ?? "?", c: d.sender?.identity?.color ?? "", t: d.content })}\n\n`);
              }
            });
            up.send(JSON.stringify({ id: 1, connect: { token, name: "js" } }));
          },
          cancel() { done = true; try { up.close(); } catch { /* ignore */ } },
        });
        return new Response(stream, { headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
      },
    },
  },
});
