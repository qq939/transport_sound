import sounddevice as sd
import numpy as np
from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask_sock import Sock
import threading
import logging
import time
import struct
import os
from assistant import assistant

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
    auto_sentence = request.args.get('auto_sentence')
    return render_template('index.html', auto_sentence=auto_sentence)

@app.route('/history')
def history_page():
    return render_template('history.html')

@app.route('/api/history', methods=['GET'])
def get_history():
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    
    data = assistant.get_history(start_date, end_date)
    return jsonify(data)

@app.route('/api/check_history', methods=['GET'])
def check_history():
    return jsonify(assistant.check_history())

@app.route('/api/delete_word', methods=['POST'])
def delete_word():
    data = request.get_json(force=True, silent=True) or {}
    word = data.get('word', '')
    dry_run = bool(data.get('dry_run', False))
    result = assistant.delete_word_from_history(word, dry_run=dry_run)
    status = 200 if result.get('status') == 'success' else 400
    return jsonify(result), status

@app.route('/open/api/analyz', methods=['POST'])
def open_api_analyze():
    # 这个接口的用途：
    # - 外部系统通过 POST JSON 传入一句/一段文本（sentence）
    # - 服务端返回一个“可直接打开的 URL”
    # - 打开该 URL 后，前端会读取 query 参数 auto_sentence，并自动触发分析流程
    #
    # 为什么你会看到“乱码 URL”：
    # - 如果 sentence 里包含中文/特殊符号/换行，而我们把它“原样拼接进 URL”
    #   浏览器/代理/日志系统会在不同编码之间转换，导致出现类似：
    #   "46â€º â€¹ ç¬”è®°" 这种典型的 UTF-8 被按 Latin-1/CP1252 误解码的乱码
    #
    # 正确做法：
    # 1) 先把 sentence 修复成尽量正常的人类可读文本（可选，但能消除常见 mojibake）
    # 2) 再把 sentence 做 URL percent-encoding，确保最终 URL 只包含 ASCII
    #    这样无论经过任何中间层，都不会出现“看起来像乱码”的问题

    def _repair_mojibake(text: str) -> str:
        """尽量把 UTF-8 被当成 Latin-1/CP1252 解码造成的乱码修复回来。

        典型现象：
        - “笔记” -> “ç¬”è®°”
        - “›” -> “â€º”
        """
        if not isinstance(text, str):
            return ''
        original = text.strip()
        if not original:
            return ''

        candidates = [original]
        for enc in ('latin-1', 'cp1252'):
            try:
                candidates.append(original.encode(enc).decode('utf-8'))
            except Exception:
                pass

        def score(s: str) -> int:
            cjk = sum(1 for ch in s if '\u4e00' <= ch <= '\u9fff')
            bad = (
                s.count('Ã')
                + s.count('â')
                + s.count('�')
                + s.count('å')
                + s.count('ç')
                + s.count('æ')
                + s.count('è')
                + s.count('é')
                + s.count('ï')
            )
            return cjk * 5 - bad * 3

        return max(candidates, key=score)

    data = request.get_json(force=True, silent=True) or {}
    sentence = _repair_mojibake(data.get('sentence', '')).strip()

    if not sentence:
        return jsonify({"error": "No sentence provided"}), 400

    # 把任意字符（包括中文、空格、换行、冒号等）编码成 URL 安全的 ASCII 形式。
    # 例如："10:40" 仍然是 "10%3A40"，避免在任何链路中被误解析。
    encoded = quote(sentence, safe='')


    return f"http://teacher.dimond.top?auto_sentence={encoded}"



@app.route('/api/analyze', methods=['POST'])
def analyze():
    data = request.json
    sentence = data.get('sentence')
    if not sentence:
        return jsonify({"error": "No sentence provided"}), 400
    
    result = assistant.analyze_sentence(sentence)
    print(result, flush=True)
    return jsonify(result)

@app.route('/api/submit_quiz', methods=['POST'])
def submit_quiz():
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400
        
    result = assistant.submit_quiz_result(data)
    return jsonify(result)

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
    cert_path = os.path.join(os.path.dirname(__file__), 'cert', 'cert.pem')
    key_path = os.path.join(os.path.dirname(__file__), 'cert', 'key.pem')
    ssl_ctx = None
    if os.path.exists(cert_path) and os.path.exists(key_path):
        ssl_ctx = (cert_path, key_path)
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True, ssl_context=ssl_ctx)