import os, asyncio, sys
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

from dotenv import load_dotenv
load_dotenv()

async def test():
    from elevenlabs.client import AsyncElevenLabs
    
    key = os.getenv("ELEVENLABS_API_KEY")
    voice_id = os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
    
    print(f"Key: {key}")
    print(f"Starts with sk_? {key.startswith('sk_') if key else 'NO KEY'}")
    
    client = AsyncElevenLabs(api_key=key)
    
    # No await - it's already an async generator
    result = client.text_to_speech.convert(
        voice_id=voice_id,
        output_format="mp3_44100_128",
        text="Hello test",
        model_id="eleven_multilingual_v2",
    )
    print(f"Type: {type(result)}")
    
    audio_data = b""
    async for chunk in result:
        if chunk:
            audio_data += chunk
    
    print(f"Audio: {len(audio_data)} bytes")
    if audio_data:
        print("SUCCESS!")
    else:
        print("FAIL - no audio")

asyncio.run(test())
