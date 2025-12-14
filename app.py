import sounddevice as sd
import numpy as np
from flask import Flask, render_template
from flask_sock import Sock
import threading
import logging
import time
import struct
import json

app = Flask(__name__)
sock = Sock(app)

# Audio settings
SAMPLE_RATE = 44100
CHANNELS = 1
BLOCK_SIZE = 2048  # 2048/44100 ~= 46ms
DTYPE = 'int16'

# Global list to hold connected clients
clients = []
clients_lock = threading.Lock()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def audio_callback(indata, frames, time_info, status):
    """Callback function for audio stream."""
    if status:
        logger.warning(f"Audio status: {status}")
    
    # Get current server time
    server_time = time.time()
    
    # Prepare payload: Timestamp (double, 8 bytes) + Audio Data (int16 bytes)
    # We use Little Endian '<d' for timestamp to match typical PC/WASM.
    timestamp_bytes = struct.pack('<d', server_time)
    audio_bytes = indata.tobytes()
    payload = timestamp_bytes + audio_bytes
    
    # Broadcast to all connected clients
    with clients_lock:
        to_remove = []
        for ws in clients:
            try:
                # Send binary payload
                ws.send(payload)
            except Exception as e:
                # logger.error(f"Error sending to client: {e}")
                to_remove.append(ws)
        
        for ws in to_remove:
            if ws in clients:
                clients.remove(ws)

def start_recording():
    """Starts the audio recording stream."""
    try:
        # Use int16 for lower bandwidth
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS, 
                            dtype=DTYPE, blocksize=BLOCK_SIZE, 
                            callback=audio_callback):
            logger.info(f"Microphone listening at {SAMPLE_RATE}Hz...")
            while True:
                sd.sleep(1000)
    except Exception as e:
        logger.error(f"Failed to start recording: {e}")
        # Retry or exit? Let's retry after a delay
        time.sleep(5)
        start_recording()

# Start recording in a separate thread
# Note: We only start it once.
recording_thread = threading.Thread(target=start_recording, daemon=True)
recording_thread.start()

@app.route('/')
def index():
    return render_template('index.html')

@sock.route('/audio')
def audio(ws):
    with clients_lock:
        clients.append(ws)
    logger.info(f"Client connected. Total: {len(clients)}")
    try:
        while True:
            # Keep connection alive, wait for any message (e.g. ping)
            # Or just block reading.
            data = ws.receive()
    except Exception as e:
        pass
    finally:
        with clients_lock:
            if ws in clients:
                clients.remove(ws)
        logger.info(f"Client disconnected. Total: {len(clients)}")

if __name__ == '__main__':
    # Listen on all interfaces
    # threaded=True is default for Flask > 1.0, but good to be explicit for simple dev server
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)
