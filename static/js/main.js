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
const stagingArea = document.getElementById('staging-area');

// Quiz State
let currentQuizData = null;
let currentQuizResults = [];
let currentWordIndex = 0;

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
    
    // Show staging area
    stagingArea.style.display = 'block';
    stagingArea.textContent = sentence;
    stagingArea.style.color = '#0f0'; // Normal color
    
    // Clear log area
    logsContent.innerHTML = '';

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
                startQuiz(data);
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

function startQuiz(data) {
    currentQuizData = data;
    currentQuizResults = [];
    currentWordIndex = 0;
    
    // data structure: { words: [{word, meaning, options}], source: "", timestamp: ..., sentence: "" }
    
    if (!data.words || data.words.length === 0) {
        // No difficult words, directly finish
        finishQuiz();
        return;
    }
    
    showNextWordCard();
}

function showNextWordCard() {
    if (currentWordIndex >= currentQuizData.words.length) {
        finishQuiz();
        return;
    }
    
    const wordInfo = currentQuizData.words[currentWordIndex];
    const options = shuffleArray([...wordInfo.options]);
    
    // Create Card UI in logsContent
    const card = document.createElement('div');
    card.className = 'log-entry';
    card.style.border = '1px solid #0f0';
    card.style.padding = '10px';
    card.style.margin = '10px 0';
    
    let html = `<div style="font-size: 20px; color: #fff; margin-bottom: 10px;">Quiz: ${wordInfo.word}</div>`;
    html += `<div style="font-size: 14px; color: #aaa; margin-bottom: 10px;">Select the correct meaning:</div>`;
    
    // Options
    options.forEach((opt, idx) => {
        html += `<button class="quiz-option" data-opt="${opt}" style="display:block; width:100%; text-align:left; margin:5px 0; padding:8px; border:1px solid #050; background:transparent; color:#0f0; cursor:pointer;">${idx + 1}. ${opt}</button>`;
    });
    
    logsContent.innerHTML = ''; // Clear previous
    logsContent.appendChild(card);
    card.innerHTML = html;
    
    // Add listeners
    const btns = card.querySelectorAll('.quiz-option');
    btns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const selected = e.target.getAttribute('data-opt');
            const isCorrect = selected === wordInfo.meaning;
            
            currentQuizResults.push({
                word: wordInfo.word,
                isCorrect: isCorrect,
                selected: selected,
                correctMeaning: wordInfo.meaning
            });
            
            // Feedback
            if (isCorrect) {
                e.target.style.background = '#050';
                e.target.innerHTML += ' ✅';
            } else {
                e.target.style.background = '#500';
                e.target.innerHTML += ' ❌';
                // Highlight correct one
                btns.forEach(b => {
                    if (b.getAttribute('data-opt') === wordInfo.meaning) {
                        b.style.background = '#050';
                        b.style.innerHTML += ' (Correct)';
                    }
                });
            }
            
            // Disable all
            btns.forEach(b => b.disabled = true);
            
            // Next after delay
            setTimeout(() => {
                currentWordIndex++;
                showNextWordCard();
            }, 1500);
        });
    });
}

async function finishQuiz() {
    // Calculate results
    const resultsPayload = {
        sentence: currentQuizData.sentence,
        source: currentQuizData.source,
        timestamp: currentQuizData.timestamp,
        results: currentQuizResults.map(r => ({
            word: r.word,
            is_correct: r.isCorrect
        }))
    };
    
    logsContent.innerHTML = '<div class="log-entry" style="color:#0f0;">Submitting results...</div>';
    
    try {
        const response = await fetch('/api/submit_quiz', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(resultsPayload)
        });
        
        const data = await response.json();
        
        // Show Final Summary
        displayFinalSummary(data);
        
    } catch (err) {
        console.error("Quiz submission error:", err);
        addLogEntry("Quiz Submission Error: " + err.message, "system");
    }
}

function displayFinalSummary(responseData) {
    logsContent.innerHTML = '';
    
    // 1. Show Sentence in logs
    addLogEntry(currentQuizData.sentence, "user");
    
    // 2. Show Staging Area (highlight wrong words if any)
    let sentenceHtml = currentQuizData.sentence;
    const wrongWords = currentQuizResults.filter(r => !r.isCorrect).map(r => r.word);
    
    // Simple replace for highlighting (case insensitive)
    wrongWords.forEach(w => {
        const regex = new RegExp(`\\b${w}\\b`, 'gi');
        sentenceHtml = sentenceHtml.replace(regex, `<span style="color:#f00; border-bottom:1px dashed #f00;">$&</span>`);
    });
    
    stagingArea.innerHTML = sentenceHtml;
    stagingArea.style.color = wrongWords.length > 0 ? '#fff' : '#0f0';
    
    // 3. Show Result Log
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    let html = `<div class="log-sentence" style="color: #fff;">Analysis Result:</div>`;
    
    if (currentQuizData.words.length > 0) {
        html += `<div class="vocab-list">Difficult Words (IELTS): `;
        currentQuizData.words.forEach(w => {
            const isWrong = wrongWords.includes(w.word);
            const style = isWrong ? 'color:#f00; border-bottom:1px solid #f00;' : 'color:#0f0;';
            html += `<span class="vocab-item" style="${style}" title="${w.meaning}">${w.word}</span>`;
        });
        html += `</div>`;
    } else {
        html += `<div class="vocab-list">No difficult words found.</div>`;
    }
    
    if (currentQuizData.source && currentQuizData.source !== "Unknown") {
         html += `<div class="history-info">Guessed Source Style: ${currentQuizData.source}</div>`;
    }
    
    if (responseData.message) {
        html += `<div class="history-info" style="margin-top:10px;">Server: ${responseData.message}</div>`;
    }
    
    entry.innerHTML = html;
    logsContent.appendChild(entry);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
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

    // Reset state variables
    queue = [];
    buffer = new Float32Array(0);
    lastTimestamp = 0;

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
    
    if (audioCtx) {
        audioCtx.close().catch(err => console.error("Error closing AudioContext:", err));
        audioCtx = null;
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
