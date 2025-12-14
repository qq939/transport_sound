// Mr.Jiang Audio Stream Client

const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');
const latencyVal = document.getElementById('latency-val');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

let audioCtx = null;
let workletNode = null;
let ws = null;
let isPlaying = false;
let analyser = null;
let drawVisual = null;

// Adjust canvas size
function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

btnPlay.addEventListener('click', startStream);
btnStop.addEventListener('click', stopStream);

async function startStream() {
    if (isPlaying) return;

    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 44100,
                latencyHint: 'interactive'
            });
        }
        
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        // Add AudioWorklet module
        await audioCtx.audioWorklet.addModule('/static/worklet-processor.js');

        // Create Worklet Node
        workletNode = new AudioWorkletNode(audioCtx, 'pcm-player');
        
        // Create Analyser for visualization
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        
        // Connect: Worklet -> Analyser -> Destination
        workletNode.connect(analyser);
        analyser.connect(audioCtx.destination);

        // Start Visualization
        visualize();

        // Connect WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/audio`;
        
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        
        ws.onopen = () => {
            console.log('Connected to server');
            isPlaying = true;
            updateUI(true);
        };
        
        ws.onmessage = (event) => {
            if (!isPlaying) return;
            
            // Parse payload: 8 bytes timestamp + Audio Data
            const arrayBuffer = event.data;
            const dataView = new DataView(arrayBuffer);
            const timestamp = dataView.getFloat64(0, true); // Little Endian
            
            // Audio data starts at offset 8
            // It's Int16, so we need to convert to Float32 [-1.0, 1.0]
            const audioInt16 = new Int16Array(arrayBuffer, 8);
            const audioFloat32 = new Float32Array(audioInt16.length);
            
            for (let i = 0; i < audioInt16.length; i++) {
                audioFloat32[i] = audioInt16[i] / 32768.0;
            }
            
            // Send to Worklet
            workletNode.port.postMessage({
                timestamp: timestamp,
                audioData: audioFloat32
            });
            
            // Calculate Latency (assuming synchronized clocks or localhost)
            // timestamp is in seconds (float)
            const now = Date.now() / 1000.0;
            const latency = (now - timestamp) * 1000; // ms
            
            latencyVal.textContent = latency.toFixed(1);
            
            // Color code latency
            if (latency < 700) {
                latencyVal.style.color = '#0f0';
            } else {
                latencyVal.style.color = '#f00';
            }
        };
        
        ws.onclose = () => {
            console.log('Disconnected');
            stopStream();
        };
        
        ws.onerror = (err) => {
            console.error('WebSocket Error:', err);
            stopStream();
        };

    } catch (err) {
        console.error('Error starting stream:', err);
        alert('Failed to start audio stream. See console for details.');
    }
}

function stopStream() {
    if (!isPlaying) return;
    
    if (ws) {
        ws.close();
        ws = null;
    }
    
    if (workletNode) {
        workletNode.disconnect();
        workletNode = null;
    }
    
    if (analyser) {
        analyser.disconnect();
        analyser = null;
    }
    
    isPlaying = false;
    updateUI(false);
    
    // Clear canvas
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    if (drawVisual) {
        cancelAnimationFrame(drawVisual);
    }
    latencyVal.textContent = '--';
}

function updateUI(playing) {
    btnPlay.disabled = playing;
    btnStop.disabled = !playing;
    
    if (playing) {
        btnPlay.innerHTML = '[ STREAMING... ]';
    } else {
        btnPlay.innerHTML = '[ RECEIVE STREAM ]';
    }
}

function visualize() {
    if (!analyser) return;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    function draw() {
        if (!isPlaying) return;
        
        drawVisual = requestAnimationFrame(draw);
        
        analyser.getByteTimeDomainData(dataArray);
        
        canvasCtx.fillStyle = '#000'; // Black background
        canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
        
        canvasCtx.lineWidth = 2;
        canvasCtx.strokeStyle = '#0f0'; // Green line
        
        canvasCtx.beginPath();
        
        const sliceWidth = canvas.width * 1.0 / bufferLength;
        let x = 0;
        
        for(let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = v * canvas.height / 2;
            
            if(i === 0) {
                canvasCtx.moveTo(x, y);
            } else {
                canvasCtx.lineTo(x, y);
            }
            
            x += sliceWidth;
        }
        
        canvasCtx.lineTo(canvas.width, canvas.height/2);
        canvasCtx.stroke();
    }
    
    draw();
}
