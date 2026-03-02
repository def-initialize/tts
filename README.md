# tts-file
TTS script for OpenClaw using ElevenLabs that converts a text file to speech and optionally sends it as a Telegram voice message.
Accepts language and voice id as arguments, otherwise uses the default values defined in OpenClaw config.

## Why

OpenClaw's built-in `tts` tool only accepts a `text` string parameter, which means the full text must pass through the LLM context window consuming tokens.

This script bypasses that entirely:
- reads the text file **directly from disk** (no LLM context involved)
- calls the **ElevenLabs API directly** via the official `@elevenlabs/elevenlabs-js` SDK
- accepts **file path**, **language**, and **voice ID** as CLI arguments
- sends the resulting audio as a **Telegram voice message** without going through OpenClaw's message pipeline

Config (API key, voice ID, model, language) is read from OpenClaw's `openclaw.json` — CLI arguments override the config values.

## Requirements

```bash
npm install          # installs @elevenlabs/elevenlabs-js
npm install -g tsx   # TypeScript runner
```

## Usage

```bash
tsx tts-file.ts --file <path> [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--file <path>` | Text file to convert (required) | — |
| `--output <path>` | Output audio file path | same name as input, `.ogg` |
| `--send` | Send to Telegram after generation | false |
| `--chat-id <id>` | Telegram chat ID | Stefano's ID (from config) |
| `--caption <text>` | Caption for the voice message | — |
| `-l` / `--lang <code>` | Language code override (e.g. `it`, `en`) | from `openclaw.json` |
| `--voice <id>` | ElevenLabs voice ID override | from `openclaw.json` |

### Examples

```bash
# Generate audio only
tsx tts-file.ts --file /tmp/chapter1.txt

# Generate and send to Telegram
tsx tts-file.ts --file /tmp/chapter1.txt --send --caption "Capitolo 1"

# Override language and voice
tsx tts-file.ts --file /tmp/chapter1.txt --send -l en --voice <voice-id>
```

## Notes

- ElevenLabs limit: **40,000 characters per request**. If the input file exceeds this, the script exits with code `2` and prints an `[AI_INSTRUCTION]` suggesting how to split the file into multiple smaller files.
- Output format: `opus_48000_32` (OGG/Opus container) — natively accepted by Telegram `sendVoice`, no conversion needed.
- Config is read from `/root/.openclaw/openclaw.json` (`messages.tts.elevenlabs.*`).
