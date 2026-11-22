import { createFileRoute } from "@tanstack/react-router";
import { ChatConsole } from "@/components/ChatConsole";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Chat Console – Kick, Twitch a YouTube chat pro outdoor stream" },
      { name: "description", content: "Živý chat z Kicku, Twitche i YouTube, zvuk alertů a nonstop provoz na mobilu pro outdoor streamery." },
      { property: "og:title", content: "Chat Console – Kick, Twitch a YouTube chat" },
      { property: "og:description", content: "Živý chat, zvuk alertů a předvolby pro každý kanál na jednom displeji." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ChatConsole,
});
