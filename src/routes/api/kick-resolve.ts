import { createFileRoute } from "@tanstack/react-router";

// Fallback when the browser can't read Kick's channel API directly. CORS-open for the static build.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

export const Route = createFileRoute("/api/kick-resolve")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const slug = new URL(request.url).searchParams.get("slug") ?? "";
        if (!/^[a-zA-Z0-9_-]{2,40}$/.test(slug)) return new Response('{"error":"bad slug"}', { status: 400, headers: CORS });
        const r = await fetch(`https://kick.com/api/v2/channels/${slug}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
        if (!r.ok) return new Response("{}", { headers: CORS });
        const j = (await r.json()) as { id?: number; chatroom?: { id?: number } };
        return new Response(JSON.stringify({ channelId: j.id ?? null, chatroomId: j.chatroom?.id ?? null }), { headers: CORS });
      },
    },
  },
});
