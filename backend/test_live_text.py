import asyncio
import os
import sys
from dotenv import load_dotenv

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

load_dotenv()

async def test_live_text():
    from google import genai
    from google.genai import types
    
    api_key = os.getenv("GEMINI_API_KEY")
    client = genai.Client(api_key=api_key, http_options={'api_version': 'v1alpha'})
    
    # Request TEXT modality instead of AUDIO
    config = types.LiveConnectConfig(
        response_modalities=["TEXT"],
        system_instruction="You are a helpful assistant. Keep responses very short."
    )
    
    print("[1] Connecting to Gemini Live API...")
    try:
        async with client.aio.live.connect(model="gemini-3.1-flash-live-preview", config=config) as session:
            print("[2] CONNECTED!")
            
            await session.send_client_content(
                turns=[types.Content(role="user", parts=[types.Part.from_text(text="Say hello and introduce yourself briefly.")])],
                turn_complete=True
            )
            print("[3] Sent test message, waiting for TEXT response...")
            
            text_received = False
            full_response = ""
            async for response in session.receive():
                server_content = getattr(response, "server_content", None)
                if server_content and server_content.model_turn:
                    for part in server_content.model_turn.parts:
                        if part.text:
                            text_received = True
                            full_response += part.text
                            print(f"  [Chunk]: {part.text}")
                if server_content and server_content.turn_complete:
                    break
            
            if text_received:
                print(f"\n*** SUCCESS! Full text: {full_response} ***")
            else:
                print("\nWARNING: Connected but no text received.")
                
    except Exception as e:
        print(f"[ERROR] Failed: {e}")

asyncio.run(test_live_text())
