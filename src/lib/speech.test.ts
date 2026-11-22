import { describe, expect, it } from "vitest";
import { preferredSpeechVoice } from "./speech";

const voice = (name: string, lang: string, voiceURI: string): SpeechSynthesisVoice => ({
  default: false,
  lang,
  localService: true,
  name,
  voiceURI,
});

describe("preferredSpeechVoice", () => {
  it("prefers a Czech female voice when available", () => {
    const voices = [
      voice("Google UK English Female", "en-GB", "en-female"),
      voice("Czech Female", "cs-CZ", "cs-female"),
      voice("Czech Voice", "cs-CZ", "cs-default"),
    ];

    expect(preferredSpeechVoice(voices)?.voiceURI).toBe("cs-female");
  });

  it("falls back to a Czech voice over a non-Czech female voice", () => {
    const voices = [
      voice("Google UK English Female", "en-GB", "en-female"),
      voice("Czech Voice", "cs-CZ", "cs-default"),
    ];

    expect(preferredSpeechVoice(voices)?.voiceURI).toBe("cs-default");
  });
});
