import asyncio
import websockets

async def test_ws():
    uri = "wss://bite-scientific-immigrants-wind.trycloudflare.com/ws/voice"
    try:
        async with websockets.connect(uri) as ws:
            print("Connected to WebSocket!")
            await asyncio.sleep(2)
            print("Sending hello...")
            await ws.send("hello")
            print("Sent!")
            await asyncio.sleep(2)
            print("Still connected!")
    except Exception as e:
        print(f"Error: {e}")

asyncio.run(test_ws())
