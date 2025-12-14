const canvas = document.getElementById('visualizer');
const ctx = canvas.getContext('2d');
const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');
const latencyVal = document.getElementById('latency-val');

let audioContext;
let audioWorkletNode;
let analyser;
let ws;
let isAudioStarted = false;
let isManuallyStopped = false;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = 200;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

async function initAudio() {
    if (isAudioStarted) return;
    
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext({
            sampleRate: 44100, // Match server
            latencyHint: 'interactive'
        });

        // Load the worklet from the correct path
        await audioContext.audioWorklet.addModule('/static/worklet-processor.js');
        
        audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-player');
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        
        audioWorkletNode.connect(analyser);
        analyser.connect(audioContext.destination);
        
        isAudioStarted = true;
        isManuallyStopped = false;
        updateButtonState(true);
        connectWebSocket();
        drawVisualizer();
        
    } catch (e) {
        console.error("Audio init failed", e);
        alert("Audio init failed: " + e.message);
    }
}

function updateButtonState(playing) {
    if (playing) {
        btnPlay.disabled = true;
        btnStop.disabled = false;
        btnPlay.innerText = "RECEIVING...";
    } else {
        btnPlay.disabled = false;
        btnStop.disabled = true;
        btnPlay.innerText = "[ RECEIVE STREAM ]";
        latencyVal.innerText = "--";
    }
}

function stopAudio() {
    isManuallyStopped = true;
    if (ws) {
        ws.close();
        ws = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    isAudioStarted = false;
    audioWorkletNode = null;
    updateButtonState(false);
}

function connectWebSocket() {
    if (isManuallyStopped) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Use /audio to match app.py
    ws = new WebSocket(`${protocol}//${window.location.host}/audio`);
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
        console.log("WS Connected");
    };
    
    ws.onclose = () => {
        if (!isManuallyStopped) {
            console.log("WS Closed, retrying...");
            setTimeout(connectWebSocket, 2000);
        }
    };
    
    ws.onerror = (e) => {
        console.error("WS Error", e);
    };
    
    ws.onmessage = (event) => {
        if (!isAudioStarted || !audioWorkletNode) return;
        
        const rawData = event.data;
        if (rawData.byteLength <= 8) return; 
        
        const dataView = new DataView(rawData);
        // Read timestamp (Little Endian)
        const serverTime = dataView.getFloat64(0, true);
        const clientTime = Date.now() / 1000.0;
        const latency = clientTime - serverTime;
        
        // Update UI occasionally
        if (Math.random() < 0.1) {
             const ms = (latency * 1000).toFixed(0);
             latencyVal.innerText = ms;
             if (latency > 0.7) {
                 latencyVal.style.color = '#f00';
             } else {
                 latencyVal.style.color = '#0f0';
             }
        }
        
        // Extract Audio Data (skip first 8 bytes)
        // Server sends int16. We need float32 for AudioWorklet.
        const int16Data = new Int16Array(rawData.slice(8));
        const float32Data = new Float32Array(int16Data.length);
        
        for (let i = 0; i < int16Data.length; i++) {
            float32Data[i] = int16Data[i] / 32768.0;
        }
        
        // Post data AND timestamp to worklet
        audioWorkletNode.port.postMessage({
            timestamp: serverTime,
            audioData: float32Data
        });
    };
}

function drawVisualizer() {
    if (!isAudioStarted) return;
    requestAnimationFrame(drawVisualizer);
    
    if (!analyser) return;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    analyser.getByteTimeDomainData(dataArray);
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0f0';
    ctx.beginPath();
    
    const sliceWidth = canvas.width * 1.0 / bufferLength;
    let x = 0;
    
    for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * canvas.height / 2;
        
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
        
        x += sliceWidth;
    }
    
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
}

btnPlay.addEventListener('click', async () => {
    await initAudio();
});

btnStop.addEventListener('click', () => {
    stopAudio();
});

// Initial State
updateButtonState(false);
