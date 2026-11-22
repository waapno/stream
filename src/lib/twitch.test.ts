import { describe, it, expect } from "vitest";
import { parseChannel } from "./twitch";
describe("parseChannel", () => {
  it("reads channel from link", () => expect(parseChannel("https://www.twitch.tv/Some_Streamer")).toBe("some_streamer"));
  it("reads popout link", () => expect(parseChannel("https://twitch.tv/popout/abc123/chat")).toBe("abc123"));
  it("accepts plain name", () => expect(parseChannel("#foo_bar")).toBe("foo_bar"));
  it("rejects garbage", () => expect(parseChannel("not a channel!")).toBeNull());
});
import { parseKick } from "./kick";
describe("parseKick", () => {
  it("reads kick link", () => expect(parseKick("https://kick.com/Some-Streamer")).toBe("some-streamer"));
  it("ignores non-kick", () => expect(parseKick("https://twitch.tv/x")).toBeNull());
});
