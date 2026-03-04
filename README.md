# tts-file

Converts text of any length to speech via ElevenLabs and optionally sends it as a Telegram voice message.

Splits long texts into chunks automatically, uses ElevenLabs **Request Stitching** to maintain natural voice prosody across chunks, then concatenates everything into a single audio file with ffmpeg.

## Why

OpenClaw's built-in `tts` tool has a hard limit of ~4,096 characters and requires the full text to pass through the LLM context window. This script bypasses both constraints:

- reads text **directly from disk** via `--file` (no LLM context involved)
- calls the **ElevenLabs API directly** via the official `@elevenlabs/elevenlabs-js` SDK
- handles **any text length** by splitting and stitching automatically
- sends a **single Telegram voice message** regardless of how many chunks were needed

## How it works

1. Text is split into chunks at sentence boundaries (`.` `!` `?`), respecting each model's `maxChars` limit defined in `tts-models.json`
2. Each chunk is sent to ElevenLabs in sequence; when the model supports it, `previousRequestIds` is passed to maintain prosody (Request Stitching)
3. Chunks are saved to a temp directory and concatenated into a single OGG file via ffmpeg at 32kbps
4. Temp files are always cleaned up (even on error)

## Model config

Model limits and stitching support are defined in `tts-models.json`:

| Model | Max chars/chunk | Stitching |
|---|---|---|
| `eleven_turbo_v2_5` | 40,000 | ✅ |
| `eleven_flash_v2_5` | 40,000 | ✅ |
| `eleven_multilingual_v2` | 10,000 | ✅ |
| `eleven_v3` | 5,000 | ❌ |

## Input methods

| Method | How |
|---|---|
| **stdin** (default) | pipe or heredoc — no escaping needed |
| `--file <path>` | read from file (preferred for long texts) |
| `--text "<text>"` | inline, for short texts |

## Options

| Flag | Description | Default |
|---|---|---|
| `--file <path>` | Read text from file | — |
| `--text "<text>"` | Inline text input | — |
| `--output <path>` | Output `.ogg` file path | derived from `--file`, or `/tmp/tts-output.ogg` |
| `--send` | Send to Telegram after generation | false |
| `--chat-id <id>` | Telegram chat ID | from `openclaw.json` |
| `--caption <text>` | Caption for the voice message | — |
| `-l` / `--lang <code>` | Language code (e.g. `it`, `en`) | from `openclaw.json` |
| `--voice <id>` | ElevenLabs voice ID | from `openclaw.json` |
| `--model <id>` | ElevenLabs model ID | from `openclaw.json` |

## Usage

```bash
# From file (recommended for long texts — text never enters LLM context)
tsx tts-file.ts --file /tmp/article.md --send --caption "Title"

# Heredoc (for translated or generated text)
tsx tts-file.ts --output /tmp/out.ogg --send --caption "Title" << 'ENDOFTEXT'
Text goes here, any length, no escaping needed.
ENDOFTEXT

# Inline (short texts only)
tsx tts-file.ts --text "Hello world" --send

# Override voice and model
tsx tts-file.ts --file /tmp/article.md --send --voice <voice-id> --model eleven_multilingual_v2
```

## Configuration

API key, voice ID, model and language are read from `/root/.openclaw/openclaw.json`:

```json
{
  "messages": {
    "tts": {
      "elevenlabs": {
        "apiKey": "...",
        "voiceId": "...",
        "modelId": "eleven_turbo_v2_5",
        "languageCode": "it"
      }
    }
  }
}
```

## Requirements

```bash
npm install       # installs @elevenlabs/elevenlabs-js
npm install -g tsx
# ffmpeg must be installed on the system (used for multi-chunk concatenation)
```
