const MAX_PENDING = 8;
const MAX_TEXT_LENGTH = 240;

type SpeechRequest = {
  text: string;
  voiceURI: string;
  onError?: (error: string) => void;
};

let queue: SpeechRequest[] = [];
let speaking = false;
let generation = 0;

export function speechSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export function preferredSpeechVoice(voices: SpeechSynthesisVoice[]) {
  const czech = voices.filter((voice) => voice.lang.toLowerCase().startsWith("cs"));
  const female = (voice: SpeechSynthesisVoice) => /female|woman|zira|samantha|aria|jenny/i.test(voice.name);
  return czech.find(female) ?? czech[0] ?? voices.find(female) ?? voices.find((voice) => voice.default) ?? voices[0];
}

function getVoice(voiceURI: string) {
  const voices = window.speechSynthesis.getVoices();
  return (voiceURI && voices.find((voice) => voice.voiceURI === voiceURI)) || preferredSpeechVoice(voices);
}

function playNext() {
  if (speaking || queue.length === 0 || !speechSupported()) return;
  const request = queue.shift();
  if (!request) return;

  const currentGeneration = generation;
  const utterance = new SpeechSynthesisUtterance(request.text);
  const voice = getVoice(request.voiceURI);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = "cs-CZ";
  }
  utterance.rate = 1.05;
  speaking = true;

  const finish = () => {
    if (currentGeneration !== generation) return;
    speaking = false;
    playNext();
  };
  utterance.onend = finish;
  utterance.onerror = (event) => {
    if (event.error !== "canceled" && event.error !== "interrupted") {
      request.onError?.(event.error);
    }
    finish();
  };
  window.speechSynthesis.speak(utterance);
}

export function speakText(text: string, voiceURI = "", onError?: (error: string) => void) {
  if (!speechSupported()) return;
  const cleanText = text.replace(/https?:\/\/\S+/gi, "odkaz").replace(/\s+/g, " ").trim();
  if (!cleanText) return;

  if (queue.length >= MAX_PENDING) queue.shift();
  queue.push({ text: cleanText.slice(0, MAX_TEXT_LENGTH), voiceURI, onError });
  playNext();
}

export function speakChatMessage(user: string, text: string, voiceURI = "", onError?: (error: string) => void) {
  speakText(`${user}: ${text}`, voiceURI, onError);
}

export function resumeSpeech() {
  if (!speechSupported()) return;
  const synthesis = window.speechSynthesis;
  if (synthesis.paused) {
    synthesis.resume();
    return;
  }
  if (speaking && !synthesis.speaking && !synthesis.pending) speaking = false;
  playNext();
}

export function stopSpeech() {
  queue = [];
  speaking = false;
  generation++;
  if (speechSupported()) window.speechSynthesis.cancel();
}
