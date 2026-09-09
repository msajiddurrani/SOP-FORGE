import os
import sys
import json
import tempfile
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Force UTF-8 on stdout AND stderr
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

load_dotenv()

app = FastAPI(title="SOP Forge Voice Engine (Groq + ElevenLabs)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Color Codes
RESET   = "\033[0m"
BOLD    = "\033[1m"
GREEN   = "\033[92m"
YELLOW  = "\033[93m"
CYAN    = "\033[96m"
RED     = "\033[91m"
MAGENTA = "\033[95m"

def log(tag: str, msg: str, color: str = CYAN):
    print(f"{color}{BOLD}[{tag}]{RESET} {msg}", flush=True)

# Initialize Clients
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb") # George default

if not GROQ_API_KEY:
    log("SYSTEM", "WARNING: GROQ_API_KEY is missing in .env!", RED)

if not ELEVENLABS_API_KEY:
    log("SYSTEM", "WARNING: ELEVENLABS_API_KEY is missing in .env!", RED)

from groq import AsyncGroq
groq_client = AsyncGroq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

from elevenlabs.client import AsyncElevenLabs
eleven_client = AsyncElevenLabs(api_key=ELEVENLABS_API_KEY) if ELEVENLABS_API_KEY else None

from agent import evaluate_intent_and_routing

@app.websocket("/ws/voice")
async def voice_call_endpoint(websocket: WebSocket):
    await websocket.accept()
    log("WS", "Frontend Client connected", GREEN)
    
    # Store conversation history for this session
    history = []

    try:
        while True:
            # Receive audio chunk (WebM from frontend)
            audio_bytes = await websocket.receive_bytes()
            log("WS", f"Received audio chunk of {len(audio_bytes)} bytes", CYAN)
            
            await websocket.send_text(json.dumps({"event": "processing"}))

            if not groq_client or not eleven_client:
                await websocket.send_text(json.dumps({"event": "error", "message": "API keys missing."}))
                continue

            # 1. Speech to Text (Groq Whisper)
            try:
                # Write to temp file because Whisper expects a file
                with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as temp_audio:
                    temp_audio.write(audio_bytes)
                    temp_audio_path = temp_audio.name
                
                with open(temp_audio_path, "rb") as file:
                    transcription = await groq_client.audio.transcriptions.create(
                        file=(temp_audio_path, file.read()),
                        model="whisper-large-v3",
                        response_format="text",
                        # We allow auto-detection so Urdu/English works seamlessly
                    )
                os.remove(temp_audio_path)
                
                user_text = transcription.strip()
                if not user_text:
                    continue # Silence detected
                    
                log("STT", f"User said: {user_text}", YELLOW)
            except Exception as e:
                log("STT", f"Whisper error: {e}", RED)
                await websocket.send_text(json.dumps({"event": "error", "message": "Speech recognition failed"}))
                continue

            # 2. LLM / Agent Routing
            try:
                result = await evaluate_intent_and_routing(user_text, history)
                response_text = result["response_text"]
                history = result["history"]
                
                log("LLM", f"AI response: {response_text}", MAGENTA)
                
                if result["action"] == "transfer":
                    log("LLM", f"Transferring to {result['target_department']}", MAGENTA)
                    await websocket.send_text(json.dumps({
                        "event": "department_transfer",
                        "target": result["target_department"]
                    }))
            except Exception as e:
                log("LLM", f"Agent error: {e}", RED)
                response_text = "I'm sorry, I encountered an error."

            # 3. Text to Speech (ElevenLabs)
            try:
                log("TTS", "Generating audio via ElevenLabs...", CYAN)
                audio_generator = eleven_client.text_to_speech.convert(
                    voice_id=VOICE_ID,
                    output_format="mp3_44100_128",
                    text=response_text,
                    model_id="eleven_multilingual_v2",
                )
                
                # Consume generator into bytes
                audio_data = b""
                async for chunk in audio_generator:
                    if chunk:
                        audio_data += chunk
                
                # Send resulting audio file back to frontend
                await websocket.send_bytes(audio_data)
                log("TTS", f"Audio generated and sent to frontend ({len(audio_data)} bytes)", GREEN)
            except Exception as e:
                log("TTS", f"ElevenLabs error: {e}", RED)
                await websocket.send_text(json.dumps({"event": "error", "message": "Voice generation failed"}))
                
    except WebSocketDisconnect:
        log("WS", "Frontend disconnected", YELLOW)
    except Exception as e:
        log("WS", f"Error: {e}", RED)
    finally:
        log("WS", "Session ended", YELLOW)

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "SOP Forge Voice Engine (Groq + ElevenLabs)"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
