import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Settings, Sun, Flashlight, FlashlightOff, X, Trash2, Plus, Radio, Clapperboard, Tv, Link2, Volume2, RotateCw, Eye, EyeOff, Check } from "lucide-react";
import { connectTwitch, parseChannel, type ChatMsg, type Platform, type Status } from "@/lib/twitch";
import { connectKick, parseKick, resolveKick } from "@/lib/kick";
import { connectYouTube, parseYouTube } from "@/lib/youtube";
import { relayBase, setRelay } from "@/lib/relay";
import { setKeepAlive, kickKeepAlive, type KeepAlive } from "@/lib/keepalive";
import { DEFAULT_PREFS, EMPTY, PLATFORM_LABEL, STORE, decode, load, newProfile, type Link, type Prefs, type Profile, type SpeechMode, type State } from "@/lib/profiles";
import { speechSupported, speakChatMessage, speakText, stopSpeech, resumeSpeech } from "@/lib/speech";

const MAX = 200;
const BASE = (import.meta.env.BASE_URL as string | undefined) ?? "/";
const TAG: Record<Platform, string> = { twitch: "T", kick: "K", youtube: "Y" };

let audioCtx: AudioContext | null = null;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state !== "running") audioCtx.resume().catch(() => {}); // phone suspends it in background
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.15;
    o.connect(g).connect(audioCtx.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18); o.stop(audioCtx.currentTime + 0.2);
  } catch { /* ignore */ }
}

/** Interpret pasted text as a chat source. Bare name = Kick (primary platform). */
function detect(input: string): { p: Platform; id: string } | null {
  const s = input.trim();
  if (!s) return null;
  if (/youtu\.?be|^@|^UC[\w-]{22}$/i.test(s)) { const y = parseYouTube(s); return y ? { p: "youtube", id: y } : null; }
  if (/twitch\.tv/i.test(s)) { const t = parseChannel(s); return t ? { p: "twitch", id: t } : null; }
  const k = parseKick(s) ?? (/kick\.com/i.test(s) ? null : parseChannel(s));
  return k ? { p: "kick", id: k } : null;
}

export function ChatConsole() {
  const [st, setSt] = useState<State>(EMPTY);
  const [ready, setReady] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [open, setOpen] = useState(false);
  const [wake, setWake] = useState(false);
  const [torch, setTorch] = useState(false);
  const [torchError, setTorchError] = useState("");
  const [speechError, setSpeechError] = useState("");
  const [unread, setUnread] = useState(0);
  const [armed, setArmed] = useState(false); // first tap happened -> audio allowed
  const [reloadKey, setReloadKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const swRef = useRef<ServiceWorkerRegistration | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const torchStreamRef = useRef<MediaStream | null>(null);

  const profile = st.profiles.find((p) => p.id === st.active) ?? null;
  const prefs = profile?.prefs ?? DEFAULT_PREFS;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const title = profile?.name ?? "Chat Console";
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    setSt(load((k) => localStorage.getItem(k)));
    setReady(true);
    if ("serviceWorker" in navigator && window.self === window.top) {
      navigator.serviceWorker.register(`${BASE}notify-sw.js`).then((r) => (swRef.current = r)).catch(() => {});
    }
  }, []);
  useEffect(() => { if (ready) localStorage.setItem(STORE, JSON.stringify(st)); }, [st, ready]);
  useEffect(() => { setRelay(st.relay); }, [st.relay]);

  const setPrefs = (p: Partial<Prefs>) =>
    setSt((s) => ({ ...s, profiles: s.profiles.map((x) => (x.id === s.active ? { ...x, prefs: { ...x.prefs, ...p } } : x)) }));

  const alertFor = useCallback((m: ChatMsg) => {
    const c = prefsRef.current;
    if (c.speech !== "off" && (c.speech === "all" || m.mention)) {
      speakChatMessage(m.user, m.text, c.speechVoice, () => setSpeechError("Předčítání se zastavilo. Zkontroluj hlasový výstup v Androidu a zkus ho znovu zapnout."));
    }
    if (c.alert === "off" || (c.alert === "mentions" && !m.mention)) return;
    if (c.vibrate && navigator.vibrate) navigator.vibrate(m.mention ? [120, 60, 120] : 60);
    if (c.sound) beep();
    if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
      const body = `${m.user}: ${m.text}`.slice(0, 180);
      const opts = { body, tag: "chat", renotify: true, silent: false } as NotificationOptions;
      if (swRef.current) swRef.current.showNotification(titleRef.current, opts).catch(() => {});
      else try { new Notification(titleRef.current, opts); } catch { /* ignore */ }
    }
  }, []);
  const previousProfile = useRef<string | null>(null);
  useEffect(() => {
    if (previousProfile.current !== profile?.id || prefs.speech === "off") stopSpeech();
    previousProfile.current = profile?.id ?? null;
  }, [profile?.id, prefs.speech]);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) resumeSpeech();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // One connection per chat in the active preset, merged into one feed.
  const chatsKey = profile?.chats.join("|") ?? "";
  useEffect(() => {
    if (!ready || !chatsKey) return;
    setMsgs([]); setStatuses({});
    const kws = prefs.keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    const onMsg = (m: ChatMsg) => {
      setMsgs((p) => (p.length >= MAX ? [...p.slice(p.length - MAX + 1), m] : [...p, m]));
      if (!stick.current) setUnread((u) => u + 1);
      alertFor(m);
    };
    const stops = chatsKey.split("|").map((key) => {
      const ch = decode(key);
      const onStatus = (s: Status) => setStatuses((x) => ({ ...x, [key]: s }));
      if (ch.p === "kick") return connectKick(ch.name, ch.room, ch.cid, kws, onMsg, onStatus);
      if (ch.p === "youtube") return connectYouTube(ch.name, kws, onMsg, onStatus);
      return connectTwitch(ch.name, kws, onMsg, onStatus);
    });
    return () => stops.forEach((s) => s());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatsKey, prefs.keywords, ready, alertFor, st.relay]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // Background keep-alive / Bluetooth speaker keep-awake.
  useEffect(() => { if (ready) setKeepAlive(armed ? prefs.keepAlive : "off", title); }, [prefs.keepAlive, armed, ready, title]);
  useEffect(() => {
    const arm = () => { setArmed(true); kickKeepAlive(); audioCtx ??= new AudioContext(); audioCtx.resume().catch(() => {}); };
    window.addEventListener("pointerdown", arm);
    return () => window.removeEventListener("pointerdown", arm);
  }, []);
  // Network came back -> reload alert overlays (their sockets may be dead).
  useEffect(() => {
    // Also after the phone was away >3 min, and every 30 min, so a silently dead alert socket recovers.
    const re = () => setReloadKey((k) => k + 1);
    let hiddenAt = 0;
    const vis = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 180000) re();
    };
    const t = setInterval(re, 30 * 60000);
    window.addEventListener("online", re);
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); window.removeEventListener("online", re); document.removeEventListener("visibilitychange", vis); };
  }, []);

  // Screen wake lock, re-acquired when coming back to the app.
  useEffect(() => {
    if (!wake) { wakeRef.current?.release().catch(() => {}); wakeRef.current = null; return; }
    const get = () => { if (document.visibilityState === "visible" && "wakeLock" in navigator) navigator.wakeLock.request("screen").then((l) => (wakeRef.current = l)).catch(() => setWake(false)); };
    get();
    document.addEventListener("visibilitychange", get);
    return () => document.removeEventListener("visibilitychange", get);
  }, [wake]);
  useEffect(() => () => {
    torchStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const toggleAlerts = async () => {
    if (prefs.alert === "off") {
      if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
      setPrefs({ alert: "mentions" });
    } else setPrefs({ alert: "off" });
  };
  const toggleSpeech = () => {
    setSpeechError("");
    if (prefs.speech === "off") {
      setPrefs({ speech: "all" });
      speakText("Předčítání zapnuto.", prefs.speechVoice, () => setSpeechError("Android hlasový výstup nespustil. Zkontroluj Text-to-speech v nastavení Androidu."));
    } else {
      setPrefs({ speech: "off" });
      stopSpeech();
    }
  };
  const toggleTorch = async () => {
    setTorchError("");
    if (torchStreamRef.current) {
      torchStreamRef.current.getTracks().forEach((track) => track.stop());
      torchStreamRef.current = null;
      setTorch(false);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setTorchError("Svítilna není v tomto prohlížeči dostupná.");
      return;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("Nebyla nalezena kamera.");
      const capabilities = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
      if (!capabilities.torch) throw new Error("Toto zařízení nebo prohlížeč nepodporuje ovládání blesku.");
      const constraints = { advanced: [{ torch: true }] } as MediaTrackConstraints & {
        advanced: (MediaTrackConstraintSet & { torch: boolean })[];
      };
      await track.applyConstraints(constraints);
      torchStreamRef.current = stream;
      setTorch(true);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      const message = error instanceof Error ? error.message : String(error);
      setTorchError(`Svítilnu se nepodařilo zapnout: ${message}`);
    }
  };

  const onScroll = () => {
    const el = listRef.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (stick.current) setUnread(0);
  };
  const jump = () => { const el = listRef.current!; el.scrollTop = el.scrollHeight; stick.current = true; setUnread(0); };

  const rate = msgs.filter((m) => Date.now() - m.ts < 60000).length;
  const chats = profile?.chats ?? [];
  const multi = new Set(chats.map((c) => decode(c).p)).size > 1;
  const dotFor = (s: Status | undefined) => (s === "live" ? "bg-primary" : !s || s === "idle" ? "bg-muted-foreground" : "bg-accent animate-pulse");
  // Static GitHub Pages build has no server of its own: Kick/YouTube need a relay address.
  const noRelay = !!import.meta.env["VITE_STATIC"] && !relayBase() && chats.some((c) => decode(c).p !== "twitch");
  const needsTap = !armed && !!profile && (prefs.overlays.length > 0 || prefs.keepAlive !== "off");

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[1600px] flex-col bg-background lg:border-x lg:border-border">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button onClick={() => setOpen(true)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="flex shrink-0 gap-1">
            {chats.length ? chats.map((c) => <span key={c} className={`size-3 rounded-full ${dotFor(statuses[c])}`} title={`${PLATFORM_LABEL[decode(c).p]} ${decode(c).name}`} />) : <span className="size-3 rounded-full bg-muted-foreground" />}
          </span>
          <span className="truncate text-lg font-bold">{profile ? profile.name : "Nastav kanál"}</span>
          {chats.length > 0 && <span className="tabular shrink-0 text-xs text-muted-foreground">{rate}/min</span>}
        </button>
        <button className="btn-icon size-10 shrink-0 sm:size-12" data-on={prefs.alert !== "off"} onClick={toggleAlerts} aria-label="Upozornění">
          {prefs.alert === "off" ? <BellOff /> : <Bell />}
        </button>
        <button className="btn-icon size-10 shrink-0 sm:size-12" data-on={prefs.speech !== "off"} onClick={toggleSpeech} aria-label={prefs.speech === "off" ? "Zapnout předčítání zpráv" : "Vypnout předčítání zpráv"} title="Předčítání zpráv" disabled={!speechSupported()}>
          <Volume2 />
        </button>
        <button className="btn-icon size-10 shrink-0 sm:size-12" data-on={wake} onClick={() => setWake((w) => !w)} aria-label="Nezhasínat displej"><Sun /></button>
        <button className="btn-icon size-10 shrink-0 sm:size-12" data-on={torch} onClick={toggleTorch} aria-label={torch ? "Vypnout svítilnu" : "Zapnout svítilnu"} title="Svítilna">
          {torch ? <FlashlightOff /> : <Flashlight />}
        </button>
        <button className="btn-icon size-10 shrink-0 sm:size-12" onClick={() => setOpen(true)} aria-label="Nastavení"><Settings /></button>
      </header>

      {noRelay && (
        <button className="tap-banner" onClick={() => setOpen(true)}>Kick/YouTube chat potřebuje adresu serveru – nastav ji v Nastavení</button>
      )}
      {needsTap && (
        <button className="tap-banner" onClick={() => setArmed(true)}>
          <Volume2 className="size-5" /> Klepni pro spuštění zvuku alertů
        </button>
      )}
      {torchError && <p role="alert" className="tap-banner">{torchError}</p>}
      {speechError && <p role="alert" className="tap-banner">{speechError}</p>}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {prefs.overlays.length > 0 && (
          <aside className={prefs.showOverlays ? "overlay-preview" : "overlay-hidden"} aria-label="Náhled alertů" aria-hidden={!prefs.showOverlays}>
            {armed && prefs.overlays.map((o, i) => (
              <iframe key={`${o.url}-${reloadKey}`} src={o.url} title={o.label || `Alert ${i + 1}`} allow="autoplay; encrypted-media" loading="eager" className="overlay-frame" />
            ))}
          </aside>
        )}

        <main className="relative min-h-0 flex-1">
          <div ref={listRef} onScroll={onScroll} className={`h-full overflow-y-auto [overflow-anchor:none] px-3 py-2 ${prefs.big ? "text-xl leading-snug" : "text-base"}`}>
            {!profile && (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-muted-foreground">
                <Radio className="size-10" />
                <p>Vlož odkaz na Kick, Twitch nebo YouTube kanál</p>
                <button className="btn-main" onClick={() => setOpen(true)}>Nastavit chat</button>
              </div>
            )}
            {profile && chats.length === 0 && <p className="pt-8 text-center text-muted-foreground">V předvolbě není žádný chat.</p>}
            {chats.length > 0 && msgs.length === 0 && <p className="pt-8 text-center text-muted-foreground">{Object.values(statuses).some((s) => s === "live") ? "Čekám na zprávy…" : "Připojuji…"}</p>}
            {msgs.map((m) => (
              <p key={m.id} className={`break-words rounded-md px-2 py-1 ${m.mention ? "msg-mention" : ""}`}>
                {multi && <span className="plat-tag" data-p={m.p}>{TAG[m.p]}</span>}
                <span className="font-bold" style={m.color ? { color: m.color } : undefined}>{m.user}</span>
                <span className="text-muted-foreground">: </span>
                {m.text}
              </p>
            ))}
          </div>
          {unread > 0 && (
            <button onClick={jump} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-5 py-3 font-bold text-primary-foreground shadow-lg">
              ↓ {unread} nových
            </button>
          )}
        </main>
      </div>

      <nav className="flex gap-2 border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {prefs.shortcuts.map((s, i) => (
          <a key={i} href={s.url} className="btn-dock" target={s.url.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
            {/obs/i.test(s.label) ? <Clapperboard className="size-5" /> : /twitch|kick|youtube/i.test(s.label) ? <Tv className="size-5" /> : <Link2 className="size-5" />}
            <span className="truncate px-1">{s.label}</span>
          </a>
        ))}
      </nav>

      {open && <SettingsPanel st={st} setSt={setSt} profile={profile} prefs={prefs} setPrefs={setPrefs} speechError={speechError} onSpeechError={setSpeechError} reload={() => setReloadKey((k) => k + 1)} close={() => setOpen(false)} />}
    </div>
  );
}

function LinkList({ items, onChange, max, labelPh, urlPh, addLabel }: { items: Link[]; onChange: (l: Link[]) => void; max: number; labelPh: string; urlPh: string; addLabel: string }) {
  return (
    <>
      {items.map((s, i) => (
        <div key={i} className="space-y-2 rounded-xl border border-border p-3">
          <div className="flex gap-2">
            <input className="field" value={s.label} placeholder={labelPh} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <button className="btn-icon size-14 shrink-0" aria-label="Odebrat" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 /></button>
          </div>
          <input className="field text-sm" value={s.url} placeholder={urlPh} autoCapitalize="off" autoCorrect="off" onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
        </div>
      ))}
      {items.length < max && (
        <button className="btn-add" onClick={() => onChange([...items, { label: "", url: "" }])}><Plus /> {addLabel}</button>
      )}
    </>
  );
}

function SettingsPanel({ st, setSt, profile, prefs, setPrefs, speechError, onSpeechError, reload, close }: {
  st: State; setSt: React.Dispatch<React.SetStateAction<State>>; profile: Profile | null; prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void; speechError: string; onSpeechError: (error: string) => void; reload: () => void; close: () => void;
}) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const src = detect(link);
  useEffect(() => {
    if (!speechSupported()) return;
    const synthesis = window.speechSynthesis;
    const updateVoices = () => setVoices(synthesis.getVoices());
    updateVoices();
    synthesis.addEventListener("voiceschanged", updateVoices);
    return () => synthesis.removeEventListener("voiceschanged", updateVoices);
  }, []);

  const addChat = async () => {
    if (!src) return;
    setErr(""); setBusy(true);
    try {
      let key = src.p === "twitch" ? `twitch:${src.id}` : `youtube:${src.id}`;
      if (src.p === "kick") {
        const r = await resolveKick(src.id);
        if (!r) { setErr("Kanál na Kicku nenalezen."); setBusy(false); return; }
        key = `kick:${src.id}:${r.chatroomId}:${r.channelId}`;
      }
      setSt((s) => {
        const cur = s.profiles.find((p) => p.id === s.active);
        if (cur) {
          if (cur.chats.includes(key)) return s;
          return { ...s, profiles: s.profiles.map((p) => (p === cur ? { ...p, chats: [...p.chats, key] } : p)) };
        }
        const p = newProfile(src.id.replace(/^@/, ""), [key]);
        return { ...s, active: p.id, profiles: [p, ...s.profiles] };
      });
      setLink("");
    } catch { setErr("Nepodařilo se načíst kanál, zkus znovu."); }
    setBusy(false);
  };
  const newPreset = () => setSt((s) => {
    const p = newProfile(`Předvolba ${s.profiles.length + 1}`, [], profile?.prefs ?? DEFAULT_PREFS);
    return { ...s, active: p.id, profiles: [...s.profiles, p] };
  });
  const patchProfile = (p: Partial<Profile>) => setSt((s) => ({ ...s, profiles: s.profiles.map((x) => (x.id === s.active ? { ...x, ...p } : x)) }));
  const removeProfile = (id: string) => setSt((s) => {
    const profiles = s.profiles.filter((p) => p.id !== id);
    return { ...s, profiles, active: s.active === id ? (profiles[0]?.id ?? null) : s.active };
  });

  const Toggle = ({ k, label }: { k: "vibrate" | "sound" | "big"; label: string }) => (
    <button onClick={() => setPrefs({ [k]: !prefs[k] })} className="toggle-row">
      {label}<span className="toggle-track" data-on={prefs[k]}><span className="toggle-knob" /></span>
    </button>
  );
  const keep: [KeepAlive, string][] = [["off", "Vypnuto"], ["tab", "Běh na pozadí"], ["bt", "+ BT reprák"]];

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-4 py-2">
        <h2 className="text-lg font-bold">Nastavení</h2>
        <button className="btn-icon" onClick={close} aria-label="Zavřít"><X /></button>
      </div>
      <div className="space-y-8 p-4 pb-16">
        <section className="space-y-3">
          <h3 className="section-title">Předvolby kanálů</h3>
          {st.profiles.length > 0 && (
            <ul className="space-y-2">
              {st.profiles.map((p) => (
                <li key={p.id} className="flex gap-2">
                  <button onClick={() => setSt((s) => ({ ...s, active: p.id }))} className="preset-btn" data-on={p.id === st.active}>
                    <span className="block truncate">{p.name || "Bez názvu"}</span>
                    <span className="block truncate text-xs font-normal opacity-75">{p.chats.map((c) => `${PLATFORM_LABEL[decode(c).p]} · ${decode(c).name}`).join(", ") || "žádný chat"}</span>
                  </button>
                  <button className="btn-icon size-14 shrink-0" aria-label="Smazat předvolbu" onClick={() => removeProfile(p.id)}><Trash2 /></button>
                </li>
              ))}
            </ul>
          )}
          <button className="btn-add" onClick={newPreset}><Plus /> Nová předvolba</button>
          <p className="hint">Upozornění, klíčová slova, alerty, zkratky i běh na pozadí se ukládají zvlášť pro každou předvolbu.</p>
        </section>

        <section className="space-y-3">
          <h3 className="section-title">{profile ? "Chaty v předvolbě" : "Zdroj chatu"}</h3>
          {profile && <input className="field" value={profile.name} placeholder="Název předvolby" onChange={(e) => patchProfile({ name: e.target.value })} />}
          {profile?.chats.map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span className="chat-chip"><span className="plat-tag" data-p={decode(c).p}>{TAG[decode(c).p]}</span>{PLATFORM_LABEL[decode(c).p]} · {decode(c).name}</span>
              <button className="btn-icon size-14 shrink-0" aria-label="Odebrat chat" onClick={() => patchProfile({ chats: profile.chats.filter((x) => x !== c) })}><Trash2 /></button>
            </div>
          ))}
          <input className="field" placeholder="kick.com/…, twitch.tv/…, youtube.com/@…" value={link} onChange={(e) => setLink(e.target.value)} autoCapitalize="off" autoCorrect="off" />
          <button className="btn-main w-full" disabled={busy || !src} onClick={addChat}>
            {busy ? "Hledám…" : src ? `${profile ? "Přidat" : "Číst"} ${PLATFORM_LABEL[src.p]} · ${src.id}` : "Vlož odkaz nebo název"}
          </button>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <p className="hint">Do jedné předvolby můžeš dát víc chatů najednou (např. Kick + YouTube při multistreamu). Holý název = Kick, YouTube jako @kanal.</p>
        </section>

        {profile && (
          <>
            <section className="space-y-3">
              <h3 className="section-title">Upozornění</h3>
              <div className="flex gap-1 rounded-xl bg-muted p-1">
                {(["off", "mentions", "all"] as const).map((a) => (
                  <button key={a} className="seg" data-on={prefs.alert === a} onClick={async () => { if (a !== "off" && typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission(); setPrefs({ alert: a }); }}>
                    {a === "off" ? "Vypnuto" : a === "mentions" ? "Zmínky" : "Vše"}
                  </button>
                ))}
              </div>
              <input className="field" placeholder="Klíčová slova: sub, donate, pozor" value={prefs.keywords} onChange={(e) => setPrefs({ keywords: e.target.value })} />
              <Toggle k="vibrate" label="Vibrace" />
              <Toggle k="sound" label="Pípnutí" />
              <Toggle k="big" label="Velké písmo" />
            </section>

            <section className="space-y-3">
              <h3 className="section-title">Předčítání chatu (TTS)</h3>
              <div className="flex gap-1 rounded-xl bg-muted p-1">
                {(["off", "mentions", "all"] as const).map((mode: SpeechMode) => (
                  <button key={mode} className="seg" data-on={prefs.speech === mode} onClick={() => setPrefs({ speech: mode })}>
                    {mode === "off" ? "Vypnuto" : mode === "mentions" ? "Zmínky" : "Všechny"}
                  </button>
                ))}
              </div>
              <label className="block space-y-2">
                <span className="hint">Hlas</span>
                <select className="field" value={prefs.speechVoice} onChange={(e) => setPrefs({ speechVoice: e.target.value })} disabled={!speechSupported()}>
                  <option value="">Automaticky – čeština, ženský pokud dostupný</option>
                  {voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}
                </select>
              </label>
              <div className="flex gap-2">
                <button className="btn-soft flex-1" disabled={!speechSupported()} onClick={() => { onSpeechError(""); speakText("Ahoj, toto je zkušební hlas předčítání chatu.", prefs.speechVoice, () => onSpeechError("Hlas se nepodařilo spustit. Zkontroluj Text-to-speech v nastavení Androidu.")); }}>
                  <Volume2 /> Vyzkoušet hlas
                </button>
              </div>
              {speechError && <p role="alert" className="text-sm text-destructive">{speechError}</p>}
              <p className="hint">
                Používá hlas dostupný v telefonu nebo počítači, bez Google API. Na Androidu předčítání odemkne první klepnutí na ikonu hlasu. Pokud není slyšet, zkontroluj v Androidu Nastavení → Usnadnění → Výstup převodu textu na řeč. Při rychlém chatu drží nejvýše 8 čekajících zpráv a starší přeskočí.
                {!speechSupported() && " Tento prohlížeč předčítání nepodporuje."}
              </p>
            </section>

            <section className="space-y-3">
              <h3 className="section-title">Alerty (browser sources)</h3>
              <p className="hint">Vlož odkazy na browser sources s alerty (StreamElements, Streamlabs, Kick…). Appka je drží načtené a přehrává jejich zvuk do telefonu / BT repráku.</p>
              <LinkList items={prefs.overlays} onChange={(overlays) => setPrefs({ overlays })} max={6} labelPh="Název (např. Alerty)" urlPh="https://…" addLabel="Přidat browser source" />
              {prefs.overlays.length > 0 && (
                <div className="flex gap-2">
                  <button className="btn-soft flex-1" onClick={() => setPrefs({ showOverlays: !prefs.showOverlays })}>{prefs.showOverlays ? <EyeOff /> : <Eye />} {prefs.showOverlays ? "Skrýt náhled" : "Ukázat náhled"}</button>
                  <button className="btn-soft flex-1" onClick={reload}><RotateCw /> Obnovit</button>
                </div>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="section-title">Nonstop provoz</h3>
              <div className="flex gap-1 rounded-xl bg-muted p-1">
                {keep.map(([k, l]) => <button key={k} className="seg" data-on={prefs.keepAlive === k} onClick={() => setPrefs({ keepAlive: k })}>{l}</button>)}
              </div>
              <p className="hint">„Běh na pozadí“ pouští úplné ticho, aby telefon appku neuspal ani po odchodu z ní. „+ BT reprák“ posílá velmi hluboký neslyšitelný tón (bez šumu), aby Bluetooth reproduktor neusnul. Na Androidu ještě přidej appku na plochu a v nastavení baterie jí povol „Bez omezení“.</p>
            </section>

            <section className="space-y-3">
              <h3 className="section-title">Zkratky dole</h3>
              <LinkList items={prefs.shortcuts} onChange={(shortcuts) => setPrefs({ shortcuts })} max={4} labelPh="Název" urlPh="Odkaz" addLabel="Přidat zkratku" />
            </section>
          </>
        )}

        <section className="space-y-3">
          <h3 className="section-title">Server pro Kick a YouTube</h3>
          <RelayField value={st.relay} onSave={(relay) => setSt((s) => ({ ...s, relay }))} />
          <p className="hint">Nech prázdné, pokud nevíš. Twitch jde napřímo, Kick a YouTube čte appka přes svůj server.</p>
        </section>
      </div>
    </div>
  );
}

function RelayField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <div className="flex gap-2">
      <input className="field text-sm" value={v} placeholder="výchozí" autoCapitalize="off" autoCorrect="off" onChange={(e) => setV(e.target.value)} />
      <button className="btn-icon size-14 shrink-0" aria-label="Uložit server" data-on={v !== value} onClick={() => onSave(v.trim())}><Check /></button>
    </div>
  );
}
