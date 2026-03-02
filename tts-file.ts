#!/usr/bin/env tsx
/**
 * tts-file.ts — Convert a text file to speech via ElevenLabs
 * and optionally send as a Telegram voice message.
 *
 * Usage:
 *   tsx tts-file.ts --file <path> [--output <path>] [--send] [--chat-id <id>] [--caption <text>]
 *
 * Examples:
 *   tsx tts-file.ts --file capitolo1.txt
 *   tsx tts-file.ts --file capitolo1.txt --send
 *   tsx tts-file.ts --file capitolo1.txt --send --caption "Capitolo 1: Mi dispiace, Dave"
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
  if (!file) {
    console.error(
      "Usage: tsx tts-file.ts --file <path> [--output <path>] [--send] [--chat-id <id>] [--caption <text>] [-l <lang>] [--voice <id>]"
    );
    process.exit(1);
  }

  const outputArg = get("--output");
  const output = outputArg ?? file.replace(/\.[^.]+$/, "") + ".ogg";
  const chatId = get("--chat-id");
  const caption = get("--caption");
  const send = has("--send");
  const lang = get("-l", "--lang");
  const voice = get("--voice");

  return { file, output, chatId, caption, send, lang, voice };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ELEVENLABS_MAX_CHARS = 40_000;

// ── TTS ───────────────────────────────────────────────────────────────────────

async function synthesize(
  text: string,
  outputPath: string,
  cfg: ReturnType<typeof loadConfig>,
  overrides?: { lang?: string; voice?: string }
): Promise<void> {
  const client = new ElevenLabsClient({ apiKey: cfg.apiKey });
  const voiceId = overrides?.voice ?? cfg.voiceId;
  const languageCode = overrides?.lang ?? cfg.languageCode;

  console.log(`⏳ ElevenLabs TTS (voice: ${voiceId}, model: ${cfg.modelId}, lang: ${languageCode ?? "auto"}) ...`);

  const audioStream = await client.textToSpeech.convert(voiceId, {
    text,
    modelId: cfg.modelId,
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
  const { file, output, chatId, caption, send, lang, voice } = parseArgs(process.argv);

  const text = readFileSync(file, "utf8").trim();
  console.log(`📄 Input: ${file} (${text.length} chars)`);

  if (text.length > ELEVENLABS_MAX_CHARS) {
    console.error(
      `\n⚠️  TEXT_TOO_LONG: ${text.length} chars exceeds the ElevenLabs limit of ${ELEVENLABS_MAX_CHARS}.\n` +
      `\n[AI_INSTRUCTION] The file "${file}" is too long for a single TTS request.\n` +
      `Split it into logical sections (e.g. by ## chapter headings), save each section\n` +
      `to a temporary file under /tmp/, then call this script once per section.\n` +
      `Example:\n` +
      `  echo "<chapter 1 text>" > /tmp/cap1.txt\n` +
      `  tsx tts-file.ts --file /tmp/cap1.txt --output /tmp/cap1.ogg --send --caption "Capitolo 1"\n` +
      `  echo "<chapter 2 text>" > /tmp/cap2.txt\n` +
      `  tsx tts-file.ts --file /tmp/cap2.txt --output /tmp/cap2.ogg --send --caption "Capitolo 2"`
    );
    process.exit(2);
  }

  console.log(`🎙️  Output: ${output}`);

  await synthesize(text, output, cfg, { lang, voice });

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
