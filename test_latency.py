import websocket
import struct
import time
import statistics
import threading
import sys

# Configuration
WS_URL = "ws://localhost:5000/audio"
DURATION = 5  # Run test for 5 seconds
MAX_LATENCY = 0.7  # 0.7 seconds

latencies = []

def on_message(ws, message):
    try:
        # Message is binary: 8 bytes timestamp + audio data
        if isinstance(message, bytes) and len(message) >= 8:
            # Unpack timestamp (double, little endian)
            server_time = struct.unpack('<d', message[:8])[0]
            current_time = time.time()
            
            latency = current_time - server_time
            latencies.append(latency)
            
            # Print current latency
            print(f"Latency: {latency*1000:.2f} ms")
    except Exception as e:
        print(f"Error parsing message: {e}")

def on_error(ws, error):
    print(f"Error: {error}")

def on_close(ws, close_status_code, close_msg):
    print("### Connection Closed ###")

def on_open(ws):
    print("### Connection Opened ###")
    # Close after DURATION seconds
    def close_later():
        time.sleep(DURATION)
        ws.close()
    
    threading.Thread(target=close_later).start()

if __name__ == "__main__":
    print(f"Connecting to {WS_URL}...")
    print(f"Testing for {DURATION} seconds...")
    
    # Enable trace for debugging if needed
    # websocket.enableTrace(True)
    
    ws = websocket.WebSocketApp(WS_URL,
                                on_open=on_open,
                                on_message=on_message,
                                on_error=on_error,
                                on_close=on_close)
    
    ws.run_forever()
    
    if latencies:
        avg_latency = statistics.mean(latencies)
        max_lat = max(latencies)
        min_lat = min(latencies)
        
        print("\n" + "="*30)
        print(f"Test Results ({len(latencies)} samples):")
        print(f"Average Latency: {avg_latency*1000:.2f} ms")
        print(f"Max Latency: {max_lat*1000:.2f} ms")
        print(f"Min Latency: {min_lat*1000:.2f} ms")
        print("="*30)
        
        if avg_latency < MAX_LATENCY:
            print("✅ TEST PASSED: Average latency is below 0.7s")
            sys.exit(0)
        else:
            print("❌ TEST FAILED: Average latency is above 0.7s")
            sys.exit(1)
    else:
        print("❌ TEST FAILED: No data received")
        sys.exit(1)
