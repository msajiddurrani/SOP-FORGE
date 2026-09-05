from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import asyncio
import json
import os
import re
from agent import evaluate_intent_and_routing
from groq import Groq
from dotenv import load_dotenv
import httpx

load_dotenv()

app = FastAPI(title="SOP Forge Voice Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for Vercel deployment
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_turbo_v2_5")

groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# ─── Whisper Hallucination / Silence Filter ───────────────────────────────────
# Whisper is known to hallucinate short phrases on silence or background noise.
# These are the most common phantom transcriptions that must be ignored.
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
    r"^\.+$",
    r"^\s*$",
    r"^music$",
    r"^\[.*\]$",              # [Music], [Silence], [Applause] etc.
    r"^\(.*\)$",              # (Music), (Silence) etc.
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


async def transcribe_audio_groq(audio_data: bytes) -> str:
    """Transcribe WebM/Opus audio using Groq Whisper API with auto-language detection (Urdu/Hindi/English)"""
    try:
        def _transcribe():
            completion = groq_client.audio.transcriptions.create(
                file=("chunk.webm", audio_data),
                model="whisper-large-v3-turbo",
                response_format="json"
            )
            return completion.text
        
        return await asyncio.to_thread(_transcribe)
    except Exception as e:
        print(f"[STT Error] Transcription failed: {e}")
        return ""

async def stream_elevenlabs_audio(text: str, websocket: WebSocket):
    """Generate TTS via ElevenLabs and stream back binary audio chunks"""
    if not text or not text.strip():
        return
        
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
    }
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL_ID,
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75
        }
    }
    
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as response:
                if response.status_code == 200:
                    # Notify frontend that audio stream is starting
                    await websocket.send_text(json.dumps({"event": "audio_start"}))
                    
                    async for chunk in response.aiter_bytes():
                        if chunk:
                            await websocket.send_bytes(chunk)
                            
                    # Notify frontend that audio stream has ended
                    await websocket.send_text(json.dumps({"event": "audio_end"}))
                else:
                    print(f"[TTS Error] ElevenLabs API error (status {response.status_code})")
                    err_msg = await response.aread()
                    print(err_msg.decode('utf-8', errors='ignore'))
    except Exception as e:
        print(f"[TTS Error] Streaming error: {e}")

@app.websocket("/ws/voice")
async def voice_call_endpoint(websocket: WebSocket):
    await websocket.accept()
    history = []
    
    # NOTE: The frontend handles the initial greeting independently.
    # We do NOT send a greeting from the backend to avoid double-greeting.
    # The LLM system prompt is aware the greeting has already been spoken.
    
    try:
        while True:
            # 1. Receive live audio frame from Next.js client
            audio_data = await websocket.receive_bytes()
            
            # 2. STT: Transcribe using Groq Whisper (auto-language detection)
            user_transcript = await transcribe_audio_groq(audio_data)
            
            # 3. Validate transcription — filter silence, noise, and Whisper hallucinations
            if not user_transcript or len(user_transcript.strip()) < 2:
                continue
            
            if is_whisper_hallucination(user_transcript):
                print(f"[Filter] Whisper hallucination ignored: '{user_transcript}'")
                continue
                
            print(f"[STT] User said: {user_transcript}")
            
            # 4. Send user transcription to frontend for display
            await websocket.send_text(json.dumps({
                "event": "transcription",
                "text": f"You: {user_transcript}"
            }))

            # 5. LLM Router: Evaluate Intent & Department
            llm_result = await evaluate_intent_and_routing(user_transcript, history)
            history = llm_result["history"]
            
            response_text = llm_result["response_text"]
            
            # Skip empty LLM responses (e.g. model returned empty content with tool call)
            if not response_text or not response_text.strip():
                response_text = llm_result.get("voice_notice", "")
            
            # 6. Send assistant response to frontend for TTS + display
            if response_text and response_text.strip():
                await websocket.send_text(json.dumps({
                    "event": "assistant_response",
                    "text": response_text,
                    "action": llm_result["action"],
                    "target": llm_result.get("target_department"),
                    "notice": llm_result.get("voice_notice")
                }))
                
                await websocket.send_text(json.dumps({
                    "event": "transcription",
                    "text": f"AI: {response_text}"
                }))
            
            # 7. Department Handoff Event
            if llm_result["action"] == "transfer":
                await websocket.send_text(json.dumps({
                    "event": "department_transfer",
                    "target": llm_result["target_department"],
                    "notice": llm_result["voice_notice"]
                }))
            
    except WebSocketDisconnect:
        print("[WS] Client disconnected")
    except Exception as e:
        print(f"[WS Error] {e}")

# Health check endpoint for deployment verification
@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "SOP Forge Voice Engine"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
