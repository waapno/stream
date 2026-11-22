import { createFileRoute } from "@tanstack/react-router";

// YouTube live chat relay (no API key, no quota): resolves the live video, then polls the
// same endpoint YouTube's own chat popout uses. Stateless: the client carries the cursor.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const H = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" };
const CORS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Run = { text?: string; emoji?: { shortcuts?: string[]; emojiId?: string } };
type Renderer = { id?: string; authorName?: { simpleText?: string }; message?: { runs?: Run[] }; purchaseAmountText?: { simpleText?: string } };

async function resolveVideo(src: string): Promise<string | null> {
  if (/^[\w-]{11}$/.test(src)) return src;
  const path = src.startsWith("@") ? `${src}/live` : /^UC[\w-]{22}$/.test(src) ? `channel/${src}/live` : null;
  if (!path) return null;
  const html = await (await fetch(`https://www.youtube.com/${path}`, { headers: H })).text();
  const canon = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
  if (canon?.[1] && /"isLive(?:Now|Content)":true/.test(html)) return canon[1];
  return null;
}

export const Route = createFileRoute("/api/yt-chat")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } }),
      GET: async ({ request }) => {
        const q = new URL(request.url).searchParams;
        const cont = q.get("c"), key = q.get("k"), ver = q.get("ver");
        try {
          if (!cont) {
            const src = (q.get("src") ?? "").trim();
            if (!/^[@\w.-]{2,100}$/.test(src)) return json({ error: "bad src" }, 400);
            const v = await resolveVideo(src);
            if (!v) return json({ offline: true });
            const html = await (await fetch(`https://www.youtube.com/live_chat?is_popout=1&v=${v}`, { headers: H })).text();
            const k = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
            const cv = html.match(/"clientVersion":"([\d.]+)"/)?.[1];
            const c = html.match(/"continuation":"([^"]+)"/)?.[1];
            if (!k || !cv || !c) return json({ offline: true, v });
            return json({ v, k, ver: cv, c, msgs: [], wait: 1000 });
          }
          if (!key || !ver || !/^[\w-]{10,80}$/.test(key) || !/^[\d.]{3,30}$/.test(ver) || cont.length > 2000) return json({ error: "bad params" }, 400);
          const r = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${key}&prettyPrint=false`, {
            method: "POST",
            headers: { ...H, "Content-Type": "application/json" },
            body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: ver } }, continuation: cont }),
          });
          if (!r.ok) return json({ ended: true, status: r.status });
          const d = (await r.json()) as { continuationContents?: { liveChatContinuation?: { continuations?: Record<string, { continuation?: string; timeoutMs?: number }>[]; actions?: { addChatItemAction?: { item?: Record<string, Renderer> } }[] } } };
          const lc = d.continuationContents?.liveChatContinuation;
          if (!lc) return json({ ended: true });
          const nx = Object.values(lc.continuations?.[0] ?? {})[0];
          const msgs = (lc.actions ?? []).flatMap((a) => {
            const item = a.addChatItemAction?.item;
            const m = item?.["liveChatTextMessageRenderer"] ?? item?.["liveChatPaidMessageRenderer"];
            if (!m?.id) return [];
            const t = (m.message?.runs ?? []).map((x) => x.text ?? x.emoji?.shortcuts?.[0] ?? "").join("");
            const paid = m.purchaseAmountText?.simpleText;
            return [{ id: m.id, u: (m.authorName?.simpleText ?? "?").replace(/^@/, ""), t: paid ? `💰 ${paid} ${t}` : t, paid: !!paid }];
          });
          return json({ c: nx?.continuation ?? null, msgs, wait: Math.min(Math.max(nx?.timeoutMs ?? 3000, 1500), 10000) });
        } catch {
          return json({ error: "youtube unavailable" }, 502);
        }
      },
    },
  },
});
