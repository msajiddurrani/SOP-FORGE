from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import json
import os
import re
import sys
from agent import evaluate_intent_and_routing
from groq import Groq
from dotenv import load_dotenv

# Force UTF-8 on stdout AND stderr so ANSI/Unicode log chars never crash
# (uvicorn writes tracebacks to stderr, which also needs reconfiguring)
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

load_dotenv()

app = FastAPI(title="SOP Forge Voice Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_turbo_v2_5")

groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# ─── ANSI Color Codes for Terminal Diagnostics ──────────────────────────────
RESET   = "\033[0m"
BOLD    = "\033[1m"
RED     = "\033[91m"
GREEN   = "\033[92m"
YELLOW  = "\033[93m"
CYAN    = "\033[96m"
MAGENTA = "\033[95m"
BLUE    = "\033[94m"

def safe_str(text: str) -> str:
    """Encode to ASCII with backslash-replace so Windows charmap can't crash."""
    return text.encode('utf-8', errors='replace').decode('utf-8', errors='replace')

def log(tag: str, msg: str, color: str = CYAN):
    print(f"{color}{BOLD}[{tag}]{RESET} {safe_str(msg)}")

# ─── Whisper Hallucination / Silence Filter ───────────────────────────────────
WHISPER_HALLUCINATION_PATTERNS = [
    r"^thank\s*you\.?$",
    r"^thanks\.?$",
    r"^thanks for watching\.?$",
    r"^subtitles?\s*(by|from).*$",
    r"^amara\.?org.*$",
    r"^please subscribe\.?$",
    r"^like and subscribe\.?$",
    r"^bye\.?$",
    r"^goodbye\.?$",
    r"^you$",
    r"^hmm\.?$",
    r"^huh\.?$",
    r"^uh\.?$",
    r"^ah\.?$",
    r"^oh\.?$",
    r"^okay\.?$",
    r"^ok\.?$",
    r"^um\.?$",
    r"^\.*$",
    r"^\s*$",
    r"^music$",
    r"^\[.*\]$",
    r"^\(.*\)$",
    r"^shukriya\.?$",
    r"^Allah Hafiz\.?$",
]

def is_whisper_hallucination(text: str) -> bool:
    """Check if transcription is a known Whisper hallucination or noise artifact."""
    cleaned = text.strip()
    if len(cleaned) < 2:
        return True
    for pattern in WHISPER_HALLUCINATION_PATTERNS:
        if re.match(pattern, cleaned, re.IGNORECASE):
            return True
    return False


async def _send_error(websocket: WebSocket, message: str):
    """Send a structured error event to the frontend and log it."""
    # Sanitize before logging so Windows charmap never crashes on Unicode chars
    safe_message = safe_str(message)
    log("WS-ERROR", safe_message, RED)
    try:
        await websocket.send_text(json.dumps({
            "event": "error",
            "message": safe_message
        }))
    except Exception:
        pass  # WebSocket may already be closing


async def transcribe_audio_groq(audio_data: bytes, websocket: WebSocket) -> str:
    """Transcribe WebM/Opus audio using Groq Whisper — with full error classification."""
    log("GROQ-STT", f"Transcribing audio chunk ({len(audio_data)} bytes)...", BLUE)
    try:
        def _transcribe():
            completion = groq_client.audio.transcriptions.create(
                file=("chunk.webm", audio_data),
                model="whisper-large-v3-turbo",
                prompt="English and Urdu.",
                response_format="json"
            )
            return completion.text

        text = await asyncio.to_thread(_transcribe)
        log("GROQ-STT", f"Result: '{text}'", GREEN)
        return text

    except Exception as e:
        err_str = str(e)
        log("GROQ-STT", f"EXCEPTION: {err_str}", RED)

        if "401" in err_str or "unauthorized" in err_str.lower() or "invalid api key" in err_str.lower():
            await _send_error(websocket, "Groq API key is invalid or expired (401 Unauthorized). Update GROQ_API_KEY.")
        elif "403" in err_str or "forbidden" in err_str.lower():
            await _send_error(websocket, "Groq API access forbidden (403). Check account permissions.")
        elif "429" in err_str or "rate limit" in err_str.lower() or "quota" in err_str.lower():
            await _send_error(websocket, "Groq STT rate limit exceeded (429). Please wait a moment.")
        elif "invalid_media_file" in err_str or "could not process file" in err_str:
            log("GROQ-STT", f"Corrupt/non-standalone audio frame received ({len(audio_data)}B) — skipping", YELLOW)
            try:
                await websocket.send_text(json.dumps({
                    "event": "status",
                    "status": "listening"
                }))
            except Exception:
                pass
        else:
            await _send_error(websocket, f"Groq STT error: {err_str}")

        return ""


async def call_llm_agent(user_transcript: str, history: list, websocket: WebSocket) -> dict | None:
    """Run the LangGraph routing agent — with full error classification."""
    log("LLM", f"Evaluating intent for: '{user_transcript}'", MAGENTA)
    try:
        result = await evaluate_intent_and_routing(user_transcript, history)
        log("LLM", f"action={result['action']}  target={result.get('target_department')}", GREEN)
        return result
    except Exception as e:
        err_str = str(e)
        log("LLM", f"EXCEPTION: {err_str}", RED)

        if "401" in err_str or "unauthorized" in err_str.lower() or "invalid api key" in err_str.lower():
            await _send_error(websocket, "Groq LLM API key is invalid or expired (401). Update GROQ_API_KEY.")
        elif "429" in err_str or "rate limit" in err_str.lower():
            await _send_error(websocket, "Groq LLM rate limit exceeded (429). Please wait.")
        else:
            await _send_error(websocket, f"LLM routing error: {err_str}")

        return None


@app.websocket("/ws/voice")
async def voice_call_endpoint(websocket: WebSocket):
    await websocket.accept()
    log("WS", "Client connected — pipeline ready", GREEN)
    history = []

    # NOTE: The frontend handles the initial greeting independently.
    # We do NOT send a greeting from the backend to avoid double-greeting.

    try:
        while True:
            # ── Step 1: Receive audio chunk ────────────────────────────────────
            try:
                audio_data = await websocket.receive_bytes()
                log("WS", f"Audio chunk received ({len(audio_data)} bytes)", CYAN)
            except WebSocketDisconnect:
                log("WS", "Client disconnected (receive_bytes)", YELLOW)
                break
            except Exception as recv_err:
                log("WS", f"receive_bytes failed: {recv_err}", RED)
                break

            # Guard: skip empty / near-empty chunks (headers only, no audio)
            if len(audio_data) < 1000:
                log("WS", f"Chunk too small ({len(audio_data)}B) — skipping", YELLOW)
                try:
                    await websocket.send_text(json.dumps({"event": "status", "status": "listening"}))
                except Exception:
                    pass
                continue

            # ── Step 2: Groq Whisper STT ───────────────────────────────────────
            user_transcript = await transcribe_audio_groq(audio_data, websocket)

            if not user_transcript or len(user_transcript.strip()) < 2:
                log("WS", "Empty/too-short transcription — skipping", YELLOW)
                try:
                    await websocket.send_text(json.dumps({"event": "status", "status": "listening"}))
                except Exception:
                    pass
                continue

            if is_whisper_hallucination(user_transcript):
                log("WS", f"Hallucination filtered: '{user_transcript}'", YELLOW)
                try:
                    await websocket.send_text(json.dumps({"event": "status", "status": "listening"}))
                except Exception:
                    pass
                continue

            log("WS", f">> User said: '{user_transcript}'", GREEN)

            # ── Step 3: Send transcription to frontend ─────────────────────────
            try:
                await websocket.send_text(json.dumps({
                    "event": "transcription",
                    "text": f"You: {user_transcript}"
                }))
                log("WS", "transcription event sent to frontend", CYAN)
            except Exception as send_err:
                log("WS", f"Failed to send transcription event: {send_err}", RED)
                break

            # ── Step 4: LLM Routing ────────────────────────────────────────────
            llm_result = await call_llm_agent(user_transcript, history, websocket)

            if llm_result is None:
                # Error already forwarded to frontend — send a safe spoken fallback
                log("WS", "LLM returned None — sending spoken fallback", YELLOW)
                try:
                    await websocket.send_text(json.dumps({
                        "event": "assistant_response",
                        "text": "I'm having a brief issue. Could you please repeat that?",
                        "action": "respond",
                        "target": None,
                        "notice": None
                    }))
                except Exception:
                    break
                continue

            history = llm_result["history"]
            response_text = llm_result["response_text"]

            if not response_text or not response_text.strip():
                response_text = llm_result.get("voice_notice", "")

            # ── Step 5: Send assistant response to frontend ────────────────────
            if response_text and response_text.strip():
                try:
                    await websocket.send_text(json.dumps({
                        "event": "assistant_response",
                        "text": response_text,
                        "action": llm_result["action"],
                        "target": llm_result.get("target_department"),
                        "notice": llm_result.get("voice_notice")
                    }))
                    short = response_text[:80] + "..." if len(response_text) > 80 else response_text
                    log("WS", f"assistant_response sent: '{short}'", GREEN)

                    await websocket.send_text(json.dumps({
                        "event": "transcription",
                        "text": f"AI: {response_text}"
                    }))
                except Exception as send_err:
                    log("WS", f"Failed to send assistant_response: {send_err}", RED)
                    break

            # ── Step 6: Department Transfer ────────────────────────────────────
            if llm_result["action"] == "transfer":
                try:
                    await websocket.send_text(json.dumps({
                        "event": "department_transfer",
                        "target": llm_result["target_department"],
                        "notice": llm_result["voice_notice"]
                    }))
                    log("WS", f"department_transfer → {llm_result['target_department']}", MAGENTA)
                except Exception as send_err:
                    log("WS", f"Failed to send department_transfer: {send_err}", RED)
                    break

    except WebSocketDisconnect:
        log("WS", "Client disconnected (outer)", YELLOW)
    except Exception as outer_err:
        log("WS", f"Unhandled loop error: {outer_err}", RED)
        try:
            await _send_error(websocket, f"Internal server error: {str(outer_err)}")
        except Exception:
            pass


# Health check endpoint for deployment verification
@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "SOP Forge Voice Engine"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
