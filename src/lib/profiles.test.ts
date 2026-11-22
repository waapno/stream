import { describe, expect, it } from "vitest";
import { load } from "./profiles";

describe("load", () => {
  it("adds default speech settings to saved profiles", () => {
    const saved = JSON.stringify({
      active: "profile-1",
      profiles: [{ id: "profile-1", name: "Test", chats: [], prefs: { alert: "all" } }],
    });

    const state = load((key) => (key === "scc.state.v2" ? saved : null));

    expect(state.profiles[0]?.prefs).toMatchObject({
      alert: "all",
      speech: "off",
      speechVoice: "",
    });
  });
});
