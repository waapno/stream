/**
 * Keeps the page "playing audio" so the phone doesn't freeze it in the background,
 * and (in "bt" mode) feeds a Bluetooth speaker a quiet signal so it doesn't fall asleep.
 * Uses a looping <audio> element: media elements keep running when the screen is off.
 */
export type KeepAlive = "off" | "tab" | "bt";
// tab = digital silence (keeps media session alive, no hiss); bt = 19 Hz sine: below hearing, but a real signal for the speaker.
const LEVEL: Record<Exclude<KeepAlive, "off">, number> = { tab: 0, bt: 0.02 };

function wav(level: number) {
  const rate = 8000, n = rate * 2, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  // 19 Hz sine (38 whole cycles in 2 s -> seamless loop). No noise = no audible hiss.
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 19 * i) / rate) * level * 32767), true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

let el: HTMLAudioElement | null = null, url = "", mode: KeepAlive = "off";

export function setKeepAlive(next: KeepAlive, title: string) {
  if (typeof window === "undefined") return;
  if (next === "off") { el?.pause(); mode = next; return; }
  if (next !== mode || !el) {
    el?.pause(); if (url) URL.revokeObjectURL(url);
    url = wav(LEVEL[next]);
    el = new Audio(url); el.loop = true;
    el.addEventListener("pause", () => { if (mode !== "off") setTimeout(() => el?.play().catch(() => {}), 500); });
  }
  mode = next;
  el.play().catch(() => {});
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: "Chat Console běží" });
    navigator.mediaSession.setActionHandler("pause", () => {});
  }
}
/** Call from any tap: browsers only start audio after a user gesture. */
export const kickKeepAlive = () => { if (mode !== "off" && el?.paused) el.play().catch(() => {}); };
export const keepAliveActive = () => mode !== "off" && !!el && !el.paused;
