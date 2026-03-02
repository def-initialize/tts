#!/usr/bin/env tsx
/**
 * tts-file.ts — Convert text to speech via ElevenLabs and optionally send as a Telegram voice message.
 *
 * Input (in order of priority):
 *   1. stdin (default) — pipe or heredoc, no escaping needed
 *   2. --text "<text>"  — inline argument
 *   3. --file <path>    — read from file
 *
 * Usage:
 *   tsx tts-file.ts [--output <path>] [--send] [--caption <text>] [-l <lang>] [--voice <id>] << 'EOF'
 *   <text here>
 *   EOF
 *
 *   tsx tts-file.ts --text "Ciao mondo" --send --caption "Test"
 *   tsx tts-file.ts --file capitolo1.txt --send --caption "Capitolo 1"
 */

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createWriteStream, readFileSync, statSync } from "fs";
import { Readable } from "stream";
import * as path from "path";
import * as fs from "fs";

// ── Config ────────────────────────────────────────────────────────────────────

const OC_CONFIG_PATH = "/root/.openclaw/openclaw.json";

function loadConfig() {
  const raw = JSON.parse(readFileSync(OC_CONFIG_PATH, "utf8"));
  const tts = raw.messages?.tts?.elevenlabs ?? {};
  const telegram = raw.channels?.telegram ?? {};
  return {
    apiKey: tts.apiKey ?? process.env.ELEVENLABS_API_KEY,
    voiceId: tts.voiceId ?? "Ap2b3ZnSIW7h0QbBbxCq",
    modelId: tts.modelId ?? "eleven_turbo_v2_5",
    languageCode: tts.languageCode as string | undefined,
    botToken: telegram.botToken,
    defaultChatId: "8401539866",
  };
}

// ── Args ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const get = (...flags: string[]) => {
    for (const flag of flags) {
      const i = args.indexOf(flag);
      if (i !== -1) return args[i + 1];
    }
    return undefined;
  };
  const has = (flag: string) => args.includes(flag);

  const file = get("--file");
  const text = get("--text");

  const outputArg = get("--output");
  const output = outputArg ?? (file ? file.replace(/\.[^.]+$/, "") + ".ogg" : "/tmp/tts-output.ogg");
  const chatId = get("--chat-id");
  const caption = get("--caption");
  const send = has("--send");
  const lang = get("-l", "--lang");
  const voice = get("--voice");
  const model = get("--model");

  return { file, text, output, chatId, caption, send, lang, voice, model };
}

// ── Stdin ─────────────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ELEVENLABS_MAX_CHARS = 40_000;

// ── TTS ───────────────────────────────────────────────────────────────────────

async function synthesize(
  text: string,
  outputPath: string,
  cfg: ReturnType<typeof loadConfig>,
  overrides?: { lang?: string; voice?: string; model?: string }
): Promise<void> {
  const client = new ElevenLabsClient({ apiKey: cfg.apiKey });
  const voiceId = overrides?.voice ?? cfg.voiceId;
  const modelId = overrides?.model ?? cfg.modelId;
  const languageCode = overrides?.lang ?? cfg.languageCode;

  console.log(`⏳ ElevenLabs TTS (voice: ${voiceId}, model: ${modelId}, lang: ${languageCode ?? "auto"}) ...`);

  const audioStream = await client.textToSpeech.convert(voiceId, {
    text,
    modelId,
    outputFormat: "opus_48000_32",
    ...(languageCode ? { languageCode } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    const writer = createWriteStream(outputPath);
    Readable.from(audioStream as AsyncIterable<Uint8Array>).pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  const { size } = statSync(outputPath);
  console.log(`✅ Saved: ${outputPath} (${(size / 1024).toFixed(1)} KB)`);
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendVoice(
  audioPath: string,
  chatId: string,
  botToken: string,
  caption?: string
): Promise<void> {
  console.log(`📤 Sending voice to Telegram chat ${chatId} ...`);

  const form = new FormData();
  form.append("chat_id", chatId);

  const audioBytes = fs.readFileSync(audioPath);
  const blob = new Blob([audioBytes], { type: "audio/ogg; codecs=opus" });
  form.append("voice", blob, path.basename(audioPath));

  if (caption) {
    form.append("caption", caption);
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
    method: "POST",
    body: form,
  });

  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) {
    throw new Error(`Telegram error: ${json.description}`);
  }
  console.log("✅ Voice message sent!");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const { file, text: inlineText, output, chatId, caption, send, lang, voice } = parseArgs(process.argv);

  let text: string;
  let source: string;

  if (inlineText !== undefined) {
    text = inlineText.trim();
    source = `--text (${text.length} chars)`;
  } else if (file !== undefined) {
    text = readFileSync(file, "utf8").trim();
    source = `${file} (${text.length} chars)`;
  } else {
    text = await readStdin();
    source = `stdin (${text.length} chars)`;
    if (!text) {
      console.error("❌ No input: provide text via stdin, --text, or --file.");
      process.exit(1);
    }
  }

  console.log(`📄 Input: ${source}`);

  if (text.length > ELEVENLABS_MAX_CHARS) {
    console.error(
      `\n⚠️  TEXT_TOO_LONG: ${text.length} chars exceeds the ElevenLabs limit of ${ELEVENLABS_MAX_CHARS}.\n` +
      `\n[AI_INSTRUCTION] The input text is too long for a single TTS request.\n` +
      `Split it into logical sections (e.g. by chapter/heading boundaries) and call this script\n` +
      `once per section using heredoc (stdin) to avoid shell escaping issues.\n` +
      `Example:\n` +
      `  tsx tts-file.ts --output /tmp/part1.ogg --send --caption "Parte 1" << 'ENDOFTEXT'\n` +
      `  <section 1 text>\n` +
      `  ENDOFTEXT\n` +
      `  tsx tts-file.ts --output /tmp/part2.ogg --send --caption "Parte 2" << 'ENDOFTEXT'\n` +
      `  <section 2 text>\n` +
      `  ENDOFTEXT`
    );
    process.exit(2);
  }

  console.log(`🎙️  Output: ${output}`);

  await synthesize(text, output, cfg, { lang, voice, model });

  if (send) {
    if (!cfg.botToken) {
      throw new Error("No Telegram botToken found in openclaw.json");
    }
    await sendVoice(output, chatId ?? cfg.defaultChatId, cfg.botToken, caption);
  }
}

main().catch((err) => {
  console.error("❌", err.message ?? err);
  process.exit(1);
});
