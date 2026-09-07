import os
from dotenv import load_dotenv
from groq import Groq
import httpx

load_dotenv()

groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

try:
    models = groq_client.models.list()
    print("GROQ: OK")
except Exception as e:
    print(f"GROQ: ERROR - {e}")

eleven_api = os.getenv("ELEVENLABS_API_KEY")
try:
    resp = httpx.get("https://api.elevenlabs.io/v1/user", headers={"xi-api-key": eleven_api})
    if resp.status_code == 200:
        print("ELEVENLABS: OK")
    else:
        print(f"ELEVENLABS: ERROR - {resp.status_code} - {resp.text}")
except Exception as e:
    print(f"ELEVENLABS: ERROR - {e}")
