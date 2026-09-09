"""Complete Environment & API Key Diagnostic for SOP Forge"""
import os
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

from dotenv import load_dotenv
load_dotenv()

print("=" * 60)
print("  SOP FORGE - COMPLETE ENV & API KEY DIAGNOSTIC")
print("=" * 60)

results = []

# ============================================================
# 1. GEMINI_API_KEY (used by main.py - the core S2S engine)
# ============================================================
print("\n[1] GEMINI_API_KEY (main.py - Gemini Live S2S)")
gemini_key = os.getenv("GEMINI_API_KEY")
if gemini_key:
    print(f"    Status: SET (prefix: {gemini_key[:10]}...)")
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=gemini_key, http_options={'api_version': 'v1alpha'})
        response = client.models.generate_content(
            model="gemini-3.6-flash",
            contents="Say OK"
        )
        print(f"    Test: PASS - Gemini API responds: '{response.text.strip()[:40]}'")
        results.append(("GEMINI_API_KEY", "PASS"))
    except Exception as e:
        print(f"    Test: FAIL - {e}")
        results.append(("GEMINI_API_KEY", f"FAIL: {e}"))
else:
    print("    Status: MISSING!")
    results.append(("GEMINI_API_KEY", "MISSING"))

# ============================================================
# 2. GROQ_API_KEY (used by agent.py - LangGraph agent)
# ============================================================
print("\n[2] GROQ_API_KEY (agent.py - LangGraph intent routing)")
groq_key = os.getenv("GROQ_API_KEY")
if groq_key:
    print(f"    Status: SET (prefix: {groq_key[:10]}...)")
    try:
        import httpx
        resp = httpx.get(
            "https://api.groq.com/openai/v1/models",
            headers={"Authorization": f"Bearer {groq_key}"},
            timeout=10
        )
        if resp.status_code == 200:
            print(f"    Test: PASS - Groq API responds OK")
            results.append(("GROQ_API_KEY", "PASS"))
        else:
            print(f"    Test: FAIL - HTTP {resp.status_code}: {resp.text[:100]}")
            results.append(("GROQ_API_KEY", f"FAIL: HTTP {resp.status_code}"))
    except Exception as e:
        print(f"    Test: FAIL - {e}")
        results.append(("GROQ_API_KEY", f"FAIL: {e}"))
else:
    print("    Status: MISSING!")
    print("    NOTE: agent.py uses this for LangGraph-based intent routing.")
    print("    The current main.py uses Gemini Live directly, so this is")
    print("    only needed if you run agent.py separately.")
    results.append(("GROQ_API_KEY", "MISSING"))

# ============================================================
# 3. ELEVENLABS_API_KEY (legacy test files only)
# ============================================================
print("\n[3] ELEVENLABS_API_KEY (test_keys.py / test_tts.py - legacy)")
eleven_key = os.getenv("ELEVENLABS_API_KEY")
if eleven_key:
    print(f"    Status: SET (prefix: {eleven_key[:10]}...)")
    try:
        import httpx
        resp = httpx.get(
            "https://api.elevenlabs.io/v1/user",
            headers={"xi-api-key": eleven_key},
            timeout=10
        )
        if resp.status_code == 200:
            print(f"    Test: PASS")
            results.append(("ELEVENLABS_API_KEY", "PASS"))
        else:
            print(f"    Test: FAIL - HTTP {resp.status_code}")
            results.append(("ELEVENLABS_API_KEY", f"FAIL: HTTP {resp.status_code}"))
    except Exception as e:
        print(f"    Test: FAIL - {e}")
        results.append(("ELEVENLABS_API_KEY", f"FAIL: {e}"))
else:
    print("    Status: NOT SET")
    print("    NOTE: Only used in old test files, NOT needed for current system.")
    results.append(("ELEVENLABS_API_KEY", "NOT SET (not needed)"))

# ============================================================
# 4. ELEVENLABS_VOICE_ID (legacy test files only)
# ============================================================
print("\n[4] ELEVENLABS_VOICE_ID (test_tts.py - legacy)")
voice_id = os.getenv("ELEVENLABS_VOICE_ID")
if voice_id:
    print(f"    Status: SET ({voice_id})")
    results.append(("ELEVENLABS_VOICE_ID", "SET"))
else:
    print("    Status: NOT SET")
    print("    NOTE: Only used in old test files, NOT needed for current system.")
    results.append(("ELEVENLABS_VOICE_ID", "NOT SET (not needed)"))

# ============================================================
# 5. Frontend: NEXT_PUBLIC_WS_URL
# ============================================================
print("\n[5] NEXT_PUBLIC_WS_URL (frontend/.env.local)")
try:
    with open("../frontend/.env.local", "r") as f:
        content = f.read()
    if "NEXT_PUBLIC_WS_URL" in content:
        for line in content.split("\n"):
            if line.startswith("NEXT_PUBLIC_WS_URL="):
                val = line.split("=", 1)[1]
                print(f"    Status: SET ({val})")
                
                # Test WebSocket endpoint reachability via HTTP health check
                import httpx
                base_url = val.replace("ws://", "http://").replace("wss://", "https://").replace("/ws/voice", "/health")
                try:
                    resp = httpx.get(base_url, timeout=5)
                    if resp.status_code == 200:
                        print(f"    Test: PASS - Backend reachable at {base_url}")
                        results.append(("NEXT_PUBLIC_WS_URL", "PASS"))
                    else:
                        print(f"    Test: FAIL - HTTP {resp.status_code}")
                        results.append(("NEXT_PUBLIC_WS_URL", f"FAIL: HTTP {resp.status_code}"))
                except Exception as e:
                    print(f"    Test: FAIL - Backend not reachable: {e}")
                    results.append(("NEXT_PUBLIC_WS_URL", f"FAIL: {e}"))
                break
    else:
        print("    Status: NOT FOUND in .env.local")
        results.append(("NEXT_PUBLIC_WS_URL", "MISSING"))
except FileNotFoundError:
    print("    Status: frontend/.env.local NOT FOUND")
    results.append(("NEXT_PUBLIC_WS_URL", "FILE NOT FOUND"))

# ============================================================
# 6. Gemini Live API Connectivity Test
# ============================================================
print("\n[6] GEMINI LIVE API (real-time S2S connection test)")
if gemini_key:
    import asyncio
    async def test_live_connection():
        try:
            from google import genai
            from google.genai import types
            client = genai.Client(api_key=gemini_key, http_options={'api_version': 'v1alpha'})
            config = types.LiveConnectConfig(response_modalities=["AUDIO"])
            async with client.aio.live.connect(model="gemini-3.1-flash-live-preview", config=config) as session:
                turn = types.Content(role="user", parts=[types.Part.from_text(text="Say OK.")])
                await session.send_client_content(turns=[turn], turn_complete=True)
                audio_chunks = 0
                async for response in session.receive():
                    sc = getattr(response, "server_content", None)
                    if sc and sc.model_turn:
                        for part in sc.model_turn.parts:
                            if part.inline_data:
                                audio_chunks += 1
                    if sc and sc.turn_complete:
                        break
                return audio_chunks
        except Exception as e:
            return str(e)
    
    result = asyncio.run(test_live_connection())
    if isinstance(result, int) and result > 0:
        print(f"    Test: PASS - Received {result} audio chunks from Gemini Live!")
        results.append(("GEMINI_LIVE_API", "PASS"))
    else:
        print(f"    Test: FAIL - {result}")
        results.append(("GEMINI_LIVE_API", f"FAIL: {result}"))
else:
    print("    SKIPPED (no GEMINI_API_KEY)")
    results.append(("GEMINI_LIVE_API", "SKIPPED"))

# ============================================================
# SUMMARY
# ============================================================
print("\n" + "=" * 60)
print("  SUMMARY")
print("=" * 60)
for name, status in results:
    icon = "[OK]" if "PASS" in status or "SET" in status else "[!!]" if "MISSING" in status or "FAIL" in status else "[--]"
    print(f"  {icon} {name:25s} -> {status}")

missing_critical = [r for r in results if r[0] in ("GEMINI_API_KEY", "GEMINI_LIVE_API", "NEXT_PUBLIC_WS_URL") and "PASS" not in r[1]]
if missing_critical:
    print(f"\n  CRITICAL ISSUES FOUND: {len(missing_critical)}")
    for name, status in missing_critical:
        print(f"    - {name}: {status}")
else:
    print("\n  ALL CRITICAL SYSTEMS: OK")
    print("  Your S2S system should be fully functional!")

print("\n" + "=" * 60)
