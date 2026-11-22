const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const KH = {
  "User-Agent": UA,
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: "https://kick.com",
  "x-app-platform": "web",
};

const YT_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "CONSENT=YES+1; SOCS=CAI",
};

type KickSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function resolveKick(slug: string) {
  const response = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!response.ok) return null;

  const data = (await response.json()) as {
    id?: number;
    chatroom?: { id?: number };
  };
  return data.id && data.chatroom?.id
    ? { channelId: data.id, chatroomId: data.chatroom.id }
    : null;
}

async function openKickSocket(url: string): Promise<KickSocket> {
  const response = (await fetch(url.replace(/^wss:/, "https:"), {
    headers: { ...KH, Upgrade: "websocket" },
  })) as Response & { webSocket?: KickSocket & { accept(): void } };

  if (!response.webSocket) throw new Error(`Kick socket upgrade failed: ${response.status}`);
  response.webSocket.accept();
  return response.webSocket;
}

async function handleKickResolve(url: URL) {
  const slug = url.searchParams.get("slug") ?? "";
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(slug)) {
    return json({ error: "bad slug" }, 400);
  }

  const result = await resolveKick(slug);
  return json(result ? result : {});
}

async function handleKickStream(request: Request, url: URL) {
  const chatroom = Number(url.searchParams.get("chatroom"));
  const channel = Number(url.searchParams.get("channel"));

  if (!Number.isInteger(chatroom) || !Number.isInteger(channel) || chatroom <= 0 || channel <= 0) {
    return new Response("bad params", { status: 400, headers: CORS });
  }

  const clientId = crypto.randomUUID();
  const negotiation = await fetch(
    `https://web.kick.com/api/v1/realtime/channels/${channel}/chat/connection`,
    {
      method: "POST",
      headers: KH,
      body: JSON.stringify({
        client: { id: clientId, type: "web" },
        capabilities: { accepted_providers: [{ provider: "centrifugo" }] },
      }),
    },
  );

  const negotiationJson = (await negotiation.json().catch(() => ({}))) as {
    data?: { connections?: { provider: string; credentials?: { url?: string } }[] };
  };
  const socketUrl = negotiationJson.data?.connections?.find(
    (connection) => connection.provider === "centrifugo",
  )?.credentials?.url;

  const auth = await fetch("https://web.kick.com/api/v1/realtime/auth/connection", {
    method: "POST",
    headers: KH,
    body: JSON.stringify({ client_id: clientId }),
  });
  const authJson = (await auth.json().catch(() => ({}))) as {
    data?: { token?: string };
  };
  const token = authJson.data?.token;

  if (!socketUrl || !/^wss:\/\/[a-z0-9.-]+\.kick\.com\//.test(socketUrl) || !token) {
    return new Response("kick unavailable", { status: 502, headers: CORS });
  }

  let upstream: KickSocket;
  try {
    upstream = await openKickSocket(socketUrl);
  } catch {
    return new Response("kick socket failed", { status: 502, headers: CORS });
  }

  const encoder = new TextEncoder();
  let done = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const output = (value: string) => {
        if (!done) {
          try {
            controller.enqueue(encoder.encode(value));
          } catch {
            finish();
          }
        }
      };

      const keepAlive = setInterval(() => output("event: ka\ndata: 1\n\n"), 15000);
      let ttlTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(keepAlive);
        clearTimeout(ttlTimer);
        try {
          upstream.close();
        } catch {}
        try {
          controller.close();
        } catch {}
      };

      request.signal.addEventListener("abort", finish);
      output("retry: 2000\n\n");
      upstream.addEventListener("close", finish);
      upstream.addEventListener("error", finish);
      upstream.addEventListener("message", (event) => {
        for (const line of String(event.data).split("\n")) {
          if (!line.trim()) continue;

          let item: Record<string, unknown>;
          try {
            item = JSON.parse(line);
          } catch {
            continue;
          }

          if (Object.keys(item).length === 0) {
            upstream.send("{}");
            continue;
          }

          if (item["id"] === 1) {
            const connect = item["connect"] as { ttl?: number } | undefined;
            if (!connect) {
              finish();
              return;
            }
            if (connect.ttl) ttlTimer = setTimeout(finish, connect.ttl * 900);
            upstream.send(
              JSON.stringify({ id: 2, subscribe: { channel: `chatrooms.${chatroom}.v2` } }),
            );
            continue;
          }

          if (item["id"] === 2) {
            if (item["error"]) finish();
            else output("event: live\ndata: 1\n\n");
            continue;
          }

          const push = item["push"] as
            | { pub?: { data?: unknown }; disconnect?: unknown }
            | undefined;
          if (!push) continue;
          if (push.disconnect) {
            finish();
            return;
          }

          let eventData = push.pub?.data as
            | { event?: string; data?: unknown }
            | string
            | undefined;
          if (typeof eventData === "string") {
            try {
              eventData = JSON.parse(eventData);
            } catch {
              continue;
            }
          }
          if (
            !eventData ||
            typeof eventData !== "object" ||
            eventData.event !== "App\\Events\\ChatMessageEvent"
          ) {
            continue;
          }

          let data = eventData.data as
            | {
                id?: string;
                content?: string;
                sender?: { username?: string; identity?: { color?: string } };
              }
            | string;
          if (typeof data === "string") {
            try {
              data = JSON.parse(data);
            } catch {
              continue;
            }
          }
          if (typeof data !== "object" || !data.content) continue;

          output(
            `data: ${JSON.stringify({
              id: data.id,
              u: data.sender?.username ?? "?",
              c: data.sender?.identity?.color ?? "",
              t: data.content,
            })}\n\n`,
          );
        }
      });

      upstream.send(JSON.stringify({ id: 1, connect: { token, name: "js" } }));
    },
    cancel() {
      done = true;
      try {
        upstream.close();
      } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

type YouTubeRun = {
  text?: string;
  emoji?: { shortcuts?: string[] };
};
type YouTubeRenderer = {
  id?: string;
  authorName?: { simpleText?: string };
  message?: { runs?: YouTubeRun[] };
  purchaseAmountText?: { simpleText?: string };
};

async function resolveYouTubeVideo(source: string): Promise<string | null> {
  if (/^[\w-]{11}$/.test(source)) return source;

  const path = source.startsWith("@")
    ? `${source}/live`
    : /^UC[\w-]{22}$/.test(source)
      ? `channel/${source}/live`
      : null;
  if (!path) return null;

  const html = await (
    await fetch(`https://www.youtube.com/${path}`, { headers: YT_HEADERS })
  ).text();
  const canonical = html.match(
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/,
  );
  if (canonical?.[1] && /"isLive(?:Now|Content)":true/.test(html)) return canonical[1];
  return null;
}

async function handleYouTube(url: URL) {
  const continuation = url.searchParams.get("c");
  const key = url.searchParams.get("k");
  const version = url.searchParams.get("ver");

  try {
    if (!continuation) {
      const source = (url.searchParams.get("src") ?? "").trim();
      if (!/^[@\w.-]{2,100}$/.test(source)) return json({ error: "bad src" }, 400);

      const video = await resolveYouTubeVideo(source);
      if (!video) return json({ offline: true });

      const html = await (
        await fetch(`https://www.youtube.com/live_chat?is_popout=1&v=${video}`, {
          headers: YT_HEADERS,
        })
      ).text();
      const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
      const clientVersion = html.match(/"clientVersion":"([\d.]+)"/)?.[1];
      const initialContinuation = html.match(/"continuation":"([^"]+)"/)?.[1];

      if (!apiKey || !clientVersion || !initialContinuation) {
        return json({ offline: true, v: video });
      }

      return json({
        v: video,
        k: apiKey,
        ver: clientVersion,
        c: initialContinuation,
        msgs: [],
        wait: 1000,
      });
    }

    if (
      !key ||
      !version ||
      !/^[\w-]{10,80}$/.test(key) ||
      !/^[\d.]{3,30}$/.test(version) ||
      continuation.length > 2000
    ) {
      return json({ error: "bad params" }, 400);
    }

    const response = await fetch(
      `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${key}&prettyPrint=false`,
      {
        method: "POST",
        headers: { ...YT_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion: version } },
          continuation,
        }),
      },
    );
    if (!response.ok) return json({ ended: true, status: response.status });

    const data = (await response.json()) as {
      continuationContents?: {
        liveChatContinuation?: {
          continuations?: Record<string, { continuation?: string; timeoutMs?: number }>[];
          actions?: {
            addChatItemAction?: { item?: Record<string, YouTubeRenderer> };
          }[];
        };
      };
    };
    const liveChat = data.continuationContents?.liveChatContinuation;
    if (!liveChat) return json({ ended: true });

    const next = Object.values(liveChat.continuations?.[0] ?? {})[0];
    const messages = (liveChat.actions ?? []).flatMap((action) => {
      const item = action.addChatItemAction?.item;
      const message =
        item?.["liveChatTextMessageRenderer"] ??
        item?.["liveChatPaidMessageRenderer"];
      if (!message?.id) return [];

      const text = (message.message?.runs ?? [])
        .map((run) => run.text ?? run.emoji?.shortcuts?.[0] ?? "")
        .join("");
      const paid = message.purchaseAmountText?.simpleText;

      return [
        {
          id: message.id,
          u: (message.authorName?.simpleText ?? "?").replace(/^@/, ""),
          t: paid ? `💰 ${paid} ${text}` : text,
          paid: !!paid,
        },
      ];
    });

    return json({
      c: next?.continuation ?? null,
      msgs: messages,
      wait: Math.min(Math.max(next?.timeoutMs ?? 3000, 1500), 10000),
    });
  } catch {
    return json({ error: "youtube unavailable" }, 502);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname === "/api/kick-resolve") return handleKickResolve(url);
    if (url.pathname === "/api/kick-stream") return handleKickStream(request, url);
    if (url.pathname === "/api/yt-chat") return handleYouTube(url);
    return json({ ok: true, service: "stream-alert-relay" });
  },
};
