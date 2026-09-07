import os
from dotenv import load_dotenv
import httpx

load_dotenv()
eleven_api = os.getenv("ELEVENLABS_API_KEY")
voice_id = os.getenv("ELEVENLABS_VOICE_ID")
url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
headers = {
    "xi-api-key": eleven_api,
    "Content-Type": "application/json",
    "Accept": "audio/mpeg"
}
payload = {
    "text": "Hello world",
    "model_id": "eleven_turbo_v2_5"
}
try:
    resp = httpx.post(url, headers=headers, json=payload)
    if resp.status_code == 200:
        print("ELEVENLABS TTS: OK")
    else:
        print(f"ELEVENLABS TTS: ERROR - {resp.status_code} - {resp.text}")
except Exception as e:
    print(f"ELEVENLABS TTS: ERROR - {e}")
