"""Quick diagnostic: verify Gemini API key and Live API access."""
import os
import sys
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
print(f"[1] GEMINI_API_KEY loaded: {'YES' if api_key else 'MISSING'}")
if api_key:
    print(f"    Key prefix: {api_key[:8]}...")

# Test 1: Basic Gemini text generation (proves the key is valid)
try:
    from google import genai
    client = genai.Client(api_key=api_key, http_options={'api_version': 'v1alpha'})
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents="Say hello in one sentence."
    )
    print(f"[2] Gemini Text API: OK — {response.text.strip()[:80]}")
except Exception as e:
    print(f"[2] Gemini Text API: FAILED — {e}")

# Test 2: Check if the Live model exists
try:
    # List models that support live/streaming
    models = client.models.list()
    live_models = [m.name for m in models if 'live' in m.name.lower() or 'flash' in m.name.lower()]
    print(f"[3] Available Live/Flash models: {live_models[:5]}")
except Exception as e:
    print(f"[3] Model listing: FAILED — {e}")

print("\n[DONE] If tests 1-2 pass, your Gemini key works for the S2S system.")
print("       Run the backend with: python -m uvicorn main:app --host 0.0.0.0 --port 8000")
