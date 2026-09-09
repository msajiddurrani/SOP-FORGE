"""Test Gemini Live API connection."""
import asyncio
import os
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

from dotenv import load_dotenv
load_dotenv()

async def test_live():
    from google import genai
    from google.genai import types
    
    api_key = os.getenv("GEMINI_API_KEY")
    
    # Default API version (not v1alpha) worked for connection
    client = genai.Client(api_key=api_key, http_options={'api_version': 'v1alpha'})
    
    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
    )
    
    print("[1] Connecting to Gemini Live API...")
    async with client.aio.live.connect(model="gemini-3.1-flash-live-preview", config=config) as session:
        print("[2] CONNECTED!")
        
        # Properly construct the Content object for turns
        turn = types.Content(
            role="user",
            parts=[types.Part.from_text(text="Say hello briefly.")]
        )
        await session.send_client_content(turns=[turn], turn_complete=True)
        print("[3] Sent test message, waiting for audio...")
        
        audio_received = False
        chunk_count = 0
        try:
            async for response in session.receive():
                server_content = getattr(response, "server_content", None)
                if server_content and server_content.model_turn:
                    for part in server_content.model_turn.parts:
                        if part.inline_data:
                            audio_received = True
                            chunk_count += 1
                            if chunk_count <= 3:
                                print(f"[4] AUDIO chunk #{chunk_count}: {len(part.inline_data.data)} bytes")
                if server_content and server_content.turn_complete:
                    break
        except Exception as e:
            print(f"[RECV ERROR] {e}")
        
        if audio_received:
            print(f"\n*** SUCCESS! Received {chunk_count} audio chunks. ***")
            print("Your Gemini Live S2S pipeline WORKS!")
        else:
            print("\nNo audio received. May need different config.")

asyncio.run(test_live())
