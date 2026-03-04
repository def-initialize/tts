#!/usr/bin/env tsx
/**
 * tts-file.ts — Convert text to speech via ElevenLabs and optionally send as a Telegram voice message.
 *
 * Accepts text of any length: splits it into chunks automatically, uses ElevenLabs
 * Request Stitching (when supported by the model) to maintain voice prosody, then
 * concatenates all chunks into a single audio file.
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
import * as os from "os";
import { execSync } from "child_process";

// ── Config ────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const OC_CONFIG_PATH = "/root/.openclaw/openclaw.json";
const MODELS_CONFIG_PATH = path.join(SCRIPT_DIR, "tts-models.json");

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

// ── Model info ────────────────────────────────────────────────────────────────

interface ModelInfo {
  maxChars: number;
  supportsStitching: boolean;
}

interface ModelsConfig {
  eleven_labs: {
    models: Record<string, ModelInfo>;
  };
}

function getModelInfo(modelId: string): ModelInfo {
  const config: ModelsConfig = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
  const info = config.eleven_labs?.models?.[modelId];
  if (!info) {
    console.warn(`⚠️  Model "${modelId}" not found in tts-models.json — defaulting to 40k chars, stitching: true`);
    return { maxChars: 40_000, supportsStitching: true };
  }
  return info;
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

  if (has("--help") || has("-h")) {
    console.log(`
tts-file — Convert text to speech via ElevenLabs and send as Telegram voice message.

Accepts text of any length. Splits into chunks automatically using sentence
boundaries (.) and uses ElevenLabs Request Stitching to maintain prosody.
All chunks are concatenated into a single audio file before sending.

INPUT (priority order):
  stdin (default)       Pipe or heredoc — no shell escaping needed
  --text "<text>"       Inline text argument
  --file <path>         Read from file

OPTIONS:
  --output <path>       Output .ogg file path (default: derived from --file, or /tmp/tts-output.ogg)
  --send                Send to Telegram after generation
  --chat-id <id>        Telegram chat ID (default: from openclaw.json)
  --caption "<text>"    Caption for the Telegram voice message
  -l, --lang <code>     Language code override, e.g. "it", "en" (default: from openclaw.json)
  --voice <id>          ElevenLabs voice ID override (default: from openclaw.json)
  --model <id>          ElevenLabs model ID override (default: from openclaw.json)
  -h, --help            Show this help

EXAMPLES:
  # Heredoc (recommended for long or complex text)
  tsx tts-file.ts --output /tmp/out.ogg --send --caption "Capitolo 1" << 'ENDOFTEXT'
  Il testo va qui, anche con "virgolette" e caratteri speciali.
  ENDOFTEXT

  # Inline text (short texts)
  tsx tts-file.ts --text "Ciao mondo" --send --caption "Test"

  # From file
  tsx tts-file.ts --file /tmp/chapter1.txt --send --caption "Capitolo 1"

  # Override language, voice and model
  tsx tts-file.ts --file /tmp/text.txt --send -l en --voice <voice-id> --model eleven_multilingual_v2

MODELS:
  Model limits and stitching support are defined in tts-models.json.
  Current models:
    eleven_turbo_v2_5      40,000 chars/chunk  stitching: yes
    eleven_flash_v2_5      40,000 chars/chunk  stitching: yes
    eleven_multilingual_v2 10,000 chars/chunk  stitching: yes
    eleven_v3               5,000 chars/chunk  stitching: no
`);
    process.exit(0);
  }

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

// ── Text splitting ────────────────────────────────────────────────────────────

/**
 * Splits text into chunks of at most `maxChars` characters.
 * Splits at the last sentence-ending punctuation (. ! ?) before the limit.
 * Falls back to the last space (word boundary) if no sentence boundary is found.
 * Falls back to a hard cut only if there is no space at all.
 */
function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const remaining = text.length - pos;
    if (remaining <= maxChars) {
      chunks.push(text.slice(pos).trim());
      break;
    }

    const slice = text.slice(pos, pos + maxChars);

    // Find last sentence boundary (. ! ?) followed by whitespace or end-of-slice
    let splitAt = -1;
    for (let i = slice.length - 1; i >= 0; i--) {
      const ch = slice[i];
      if (ch === "." || ch === "!" || ch === "?") {
        const next = slice[i + 1];
        if (next === undefined || /\s/.test(next)) {
          splitAt = i + 1; // include the punctuation
          break;
        }
      }
    }

    // Fallback: last space (word boundary)
    if (splitAt === -1) {
      splitAt = slice.lastIndexOf(" ");
    }

    // Last resort: hard cut
    if (splitAt === -1) {
      splitAt = maxChars;
    }

    chunks.push(text.slice(pos, pos + splitAt).trim());
    pos += splitAt;

    // Skip leading whitespace before next chunk
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  }

  return chunks.filter((c) => c.length > 0);
}

// ── TTS with stitching ────────────────────────────────────────────────────────

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
  const modelInfo = getModelInfo(modelId);

  const chunks = splitText(text, modelInfo.maxChars);
  const totalChunks = chunks.length;

  console.log(
    `🎙️  Model: ${modelId} | max ${modelInfo.maxChars} chars/chunk | ` +
    `stitching: ${modelInfo.supportsStitching} | chunks: ${totalChunks}`
  );

  // Single chunk: simple path, no temp files needed
  if (totalChunks === 1) {
    console.log(`⏳ Single chunk (${chunks[0].length} chars) ...`);
    const audioStream = await client.textToSpeech.convert(voiceId, {
      text: chunks[0],
      modelId,
      outputFormat: "opus_48000_32",
      ...(languageCode ? { languageCode } : {}),
    });
    await streamToFile(audioStream, outputPath);
    console.log(`✅ Saved: ${outputPath} (${(statSync(outputPath).size / 1024).toFixed(1)} KB)`);
    return;
  }

  // Multiple chunks: use temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-"));
  const chunkPaths: string[] = [];
  const requestIds: string[] = [];

  try {
    for (let i = 0; i < totalChunks; i++) {
      const chunk = chunks[i];
      const chunkPath = path.join(tmpDir, `chunk_${i}.ogg`);
      chunkPaths.push(chunkPath);

      console.log(`⏳ Chunk ${i + 1}/${totalChunks} (${chunk.length} chars) ...`);

      if (modelInfo.supportsStitching) {
        const response = await client.textToSpeech
          .convert(voiceId, {
            text: chunk,
            modelId,
            outputFormat: "opus_48000_32",
            ...(languageCode ? { languageCode } : {}),
            ...(requestIds.length > 0 ? { previousRequestIds: requestIds.slice(-3) } : {}),
          })
          .withRawResponse();

        const requestId = response.rawResponse.headers.get("request-id");
        if (requestId) requestIds.push(requestId);

        const buffers: Buffer[] = [];
        for await (const data of response.data as AsyncIterable<Uint8Array>) {
          buffers.push(Buffer.from(data));
        }
        fs.writeFileSync(chunkPath, Buffer.concat(buffers));
      } else {
        const audioStream = await client.textToSpeech.convert(voiceId, {
          text: chunk,
          modelId,
          outputFormat: "opus_48000_32",
          ...(languageCode ? { languageCode } : {}),
        });
        await streamToFile(audioStream, chunkPath);
      }

      console.log(`  ✅ Chunk ${i + 1} saved (${(statSync(chunkPath).size / 1024).toFixed(1)} KB)`);
    }

    // Concatenate with ffmpeg
    const listPath = path.join(tmpDir, "list.txt");
    fs.writeFileSync(listPath, chunkPaths.map((p) => `file '${p}'`).join("\n"));

    console.log(`🔗 Concatenating ${totalChunks} chunks ...`);
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:a libopus -b:a 32k "${outputPath}"`,
      { stdio: "pipe" }
    );

    console.log(`✅ Saved: ${outputPath} (${(statSync(outputPath).size / 1024).toFixed(1)} KB)`);
  } finally {
    // Always clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`🗑️  Temp files cleaned up`);
  }
}

function streamToFile(audioStream: unknown, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const writer = createWriteStream(outputPath);
    Readable.from(audioStream as AsyncIterable<Uint8Array>).pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
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
  const { file, text: inlineText, output, chatId, caption, send, lang, voice, model } = parseArgs(process.argv);

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
