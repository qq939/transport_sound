from flask import Flask, render_template
from flask_sock import Sock
import sounddevice as sd
import queue

app = Flask(__name__)
sock = Sock(app)

SR = 48000
CHANNELS = 1
BLOCK_SIZE = 1024

@app.route('/')
def index():
    return render_template('index.html')

@sock.route('/ws')
def audio(ws):
    q = queue.Queue(maxsize=20)
    def cb(indata, frames, time, status):
        try:
            q.put_nowait(indata.copy())
        except queue.Full:
            pass
    with sd.InputStream(samplerate=SR, channels=CHANNELS, blocksize=BLOCK_SIZE, dtype='float32', callback=cb):
        while True:
            try:
                chunk = q.get()
                ws.send(chunk.tobytes())
            except Exception:
                break

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
