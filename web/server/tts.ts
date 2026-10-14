/**
 * Natural-sounding speech for Claude's replies, made on this computer with Kokoro (82M parameters,
 * Apache 2.0). The model (~90 MB) downloads from Hugging Face on first use and is cached after that.
 * The page asks for one sentence at a time, so the first words play while the rest are made.
 */
import type { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Voices offered in Settings, best first. Kokoro has more; these are the clearest. */
export const VOICES = [
  { id: "af_heart", name: "Heart (US, warm)" },
  { id: "af_bella", name: "Bella (US)" },
  { id: "af_nicole", name: "Nicole (US, soft)" },
  { id: "am_michael", name: "Michael (US)" },
  { id: "am_fenrir", name: "Fenrir (US, deep)" },
  { id: "am_puck", name: "Puck (US, upbeat)" },
  { id: "bf_emma", name: "Emma (British)" },
  { id: "bf_isabella", name: "Isabella (British)" },
  { id: "bm_george", name: "George (British)" },
  { id: "bm_fable", name: "Fable (British)" },
] as const;

export const DEFAULT_VOICE = VOICES[0].id;

export class Speaker {
  private model: Promise<KokoroTTS> | null = null;
  /** Requests run one at a time: the model is not safe to call concurrently. */
  private queue: Promise<unknown> = Promise.resolve();
  ready = false;
  failed: string | null = null;

  constructor(private readonly log: (...parts: unknown[]) => void) {}

  /** Starts loading the model in the background; `speak` waits for it. */
  warm(): Promise<KokoroTTS> {
    this.model ??= (async () => {
      const t0 = performance.now();
      const { KokoroTTS } = await import("kokoro-js");
      const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "cpu" });
      this.ready = true;
      this.log(`natural voice ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      return tts;
    })().catch((err) => {
      this.failed = err instanceof Error ? err.message : String(err);
      this.model = null;
      this.log("natural voice unavailable:", this.failed);
      throw err;
    });
    return this.model;
  }

  /** One WAV file for `text` (a sentence or two) in `voice`. */
  speak(text: string, voice: string, speed = 1): Promise<Buffer> {
    const id = VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE;
    const run = this.queue.then(async () => {
      const tts = await this.warm();
      const audio = await tts.generate(text, { voice: id as (typeof VOICES)[number]["id"], speed });
      return Buffer.from(audio.toWav());
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/**
 * Splits a reply into chunks to speak one after another: whole sentences, joined while short so the
 * voice doesn't pause after every "Okay.", and capped so the first chunk comes back quickly.
 */
export function chunks(text: string, max = 220): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/.+?(?:[.!?]+(?=\s|$)|$)/g) ?? [];
  const out: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (current && (current.length + s.length + 1 > max || current.length >= 30)) {
      out.push(current);
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current) out.push(current);
  return out;
}
