// Mr.Jiang Audio Stream Client

const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');
const latencyVal = document.getElementById('latency-val');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

let audioCtx = null;
let workletNode = null;
let scriptProcessor = null;
let ws = null;
let isPlaying = false;
let analyser = null;
let drawVisual = null;
let queue = [];
let buffer = new Float32Array(0);
let lastTimestamp = 0;
const maxQueueLength = 10;

const btnSubmit = document.getElementById('btn-submit');
const sentenceInput = document.getElementById('sentence-input');
const logsContent = document.getElementById('logs-content');

// Adjust canvas size
function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

btnPlay.addEventListener('click', startStream);
btnStop.addEventListener('click', stopStream);

// New Event Listeners for Assistant
btnSubmit.addEventListener('click', submitSentence);
sentenceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        submitSentence();
    }
});

async function submitSentence() {
    const sentence = sentenceInput.value.trim();
    if (!sentence) return;

    // UI Feedback
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '[ 分析中... ]';
    
    // Add user log entry immediately
    addLogEntry(sentence, "user");

    try {
        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sentence: sentence })
        });

        const data = await response.json();
        
        if (response.ok) {
            if (data.error) {
                addLogEntry("Error: " + data.error, "system");
            } else {
                displayAnalysisResult(data);
            }
        } else {
            addLogEntry("Server Error: " + (data.error || response.statusText), "system");
        }

    } catch (err) {
        console.error("Submission error:", err);
        addLogEntry("Network Error: " + err.message, "system");
    } finally {
        // Reset UI
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = '[ 提交识别 ]';
        sentenceInput.value = '';
    }
}

function addLogEntry(text, type) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    if (type === "user") {
        entry.innerHTML = `<div class="log-sentence" style="color: #0f0;">> ${text}</div>`;
    } else {
        entry.innerHTML = `<div class="log-sentence" style="color: #f00;">System: ${text}</div>`;
    }
    
    logsContent.prepend(entry);
}

function displayAnalysisResult(data) {
    // data structure: 
    // { 
    //   current_analysis: { words: [], source: "", timestamp: ... }, 
    //   history_matches: { "word": [ {sentence, source, timestamp}, ... ] } 
    // }
    
    const analysis = data.current_analysis;
    const history = data.history_matches || {};
    
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    // 1. Sentence
    let html = `<div class="log-sentence" style="color: #fff;">${analysis.words.length > 0 ? "Analysis Result:" : "No difficult words found."}</div>`;
    
    // 2. Vocabulary
    if (analysis.words && analysis.words.length > 0) {
        html += `<div class="vocab-list">Difficult Words (IELTS): `;
        
        analysis.words.forEach(word => {
            const matches = history[word];
            const hasHistory = matches && matches.length > 0;
            const tooltipTitle = hasHistory ? `Found in ${matches.length} past sentences` : "New word";
            
            html += `<span class="vocab-item" title="${tooltipTitle}">${word}</span>`;
        });
        
        html += `</div>`;
        
        // 3. Detailed History
        Object.keys(history).forEach(word => {
            const matches = history[word];
            if (matches && matches.length > 0) {
                html += `<div class="history-info">`;
                html += `[${word}] also appeared in:`;
                html += `<ul style="margin: 5px 0 10px 20px; padding: 0;">`;
                matches.forEach(m => {
                    const dateStr = new Date(m.timestamp * 1000).toLocaleString();
                    html += `<li>"${m.sentence.substring(0, 30)}..." (Source: ${m.source || 'Unknown'}) @ ${dateStr}</li>`;
                });
                html += `</ul>`;
                html += `</div>`;
            }
        });
    }

    if (analysis.source && analysis.source !== "Unknown") {
         html += `<div class="history-info">Guessed Source Style: ${analysis.source}</div>`;
    }

    entry.innerHTML = html;
    logsContent.prepend(entry);
}

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

        let useWorklet = false;
        try {
            await audioCtx.audioWorklet.addModule('/static/worklet-processor.js');
            workletNode = new AudioWorkletNode(audioCtx, 'pcm-player');
            useWorklet = true;
        } catch (e) {
            scriptProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
            scriptProcessor.onaudioprocess = (ev) => {
                const out = ev.outputBuffer.getChannelData(0);
                let offset = 0;
                while (offset < out.length) {
                    if (buffer.length === 0) {
                        if (queue.length === 0) {
                            for (let i = 0; i < out.length; i++) out[i] = 0;
                            break;
                        } else {
                            buffer = queue.shift();
                        }
                    }
                    const need = out.length - offset;
                    const avail = buffer.length;
                    const n = Math.min(need, avail);
                    out.set(buffer.subarray(0, n), offset);
                    buffer = buffer.subarray(n);
                    offset += n;
                }
            };
        }
        
        // Create Analyser for visualization
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        
        if (workletNode) {
            workletNode.connect(analyser);
        } else if (scriptProcessor) {
            scriptProcessor.connect(analyser);
        }
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
            
            if (workletNode) {
                if (timestamp < lastTimestamp) {
                    return;
                }
                lastTimestamp = timestamp;
                workletNode.port.postMessage({ timestamp, audioData: audioFloat32 });
            } else if (scriptProcessor) {
                if (timestamp < lastTimestamp) {
                    return;
                }
                lastTimestamp = timestamp;
                queue.push(audioFloat32);
                if (queue.length > maxQueueLength) {
                    const dropCount = queue.length - 2;
                    queue = queue.slice(dropCount);
                }
            }
            
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
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor.onaudioprocess = null;
        scriptProcessor = null;
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
