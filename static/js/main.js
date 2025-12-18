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

// Adjust canvas size
function resizeCanvas() {
    if (!canvas || !canvas.parentElement) return;
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

if (btnPlay) {
    btnPlay.addEventListener('click', startStream);
}
if (btnStop) {
    btnStop.addEventListener('click', stopStream);
}

const btnSubmit = document.getElementById('btn-submit');
const sentenceInput = document.getElementById('sentence-input');
const logsContent = document.getElementById('logs-content');
const stagingArea = document.getElementById('staging-area');
const tabLog = document.getElementById('tab-log');
const tabHistory = document.getElementById('tab-history');
const tabVocab = document.getElementById('tab-vocab');
const historyContent = document.getElementById('history-content');
const historyHint = document.getElementById('history-hint');
const historyList = document.getElementById('history-list');
const historyStart = document.getElementById('history-start');
const historyEnd = document.getElementById('history-end');
const historyFilterBtn = document.getElementById('history-filter-btn');
const historyDownloadBtn = document.getElementById('history-download-btn');
const vocabContent = document.getElementById('vocab-content');
const vocabList = document.getElementById('vocab-list');
const vocabHint = document.getElementById('vocab-hint');
const vocabRefreshBtn = document.getElementById('vocab-refresh-btn');
let historyCache = [];
let vocabCache = [];

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightSentence(sentence, words) {
    if (!sentence) return '';
    let text = String(sentence);
    // Find all matches ranges
    // Range: {start, end}
    let ranges = [];

    const list = (Array.isArray(words) ? words : []).filter(Boolean);
    
    // Helper to add ranges
    const addRanges = (keyword) => {
        if (!keyword || keyword.length < 2) return; // Skip too short
        const escaped = escapeRegExp(keyword);
        // Try to match whole word if possible, but fallback to substring
        // Using word boundary for start might be good, but end might be punctuation
        // Let's try simple substring match first, case insensitive
        const regex = new RegExp(escaped, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
            ranges.push({start: match.index, end: match.index + match[0].length});
        }
    };

    list.forEach(word => {
        // 1. Try exact match
        addRanges(word);
        
        // 2. If it's a phrase, try removing "one's", "sb's" etc.
        if (word.includes(' ')) {
            // Remove common placeholders
            const cleaned = word.replace(/\b(one's|sb's|someone's|something|sth)\b/gi, '').replace(/\s+/g, ' ').trim();
            if (cleaned !== word && cleaned.length > 3) {
                addRanges(cleaned);
            }
            
            // 3. Partial phrase matching (if word has > 2 parts, match any 2 consecutive parts?)
            // Or just match the longest word in the phrase if it is long enough?
            // Let's try to split by space and match consecutive segments if > 1 word
            const parts = word.split(/\s+/).filter(p => p.length > 2 && !/^(one's|sb's|the|a|an|to|of|in)$/i.test(p));
            if (parts.length > 1) {
                // Try matching the whole sequence of parts with anything in between? No that's too loose.
                // Just try matching each significant part? 
                // The user said "partial match is okay". 
                // Highlighting "eyes" and "flashed" separately might be noisy but acceptable.
                // Better: try to find the longest contiguous sub-phrase that exists in text.
                
                // Let's just add ranges for significant parts for now, later merge will handle overlaps.
                parts.forEach(p => addRanges(p));
            }
        }
    });

    // Merge overlapping ranges
    if (ranges.length === 0) return escapeHtml(text);

    ranges.sort((a, b) => a.start - b.start);
    
    let merged = [];
    let current = ranges[0];
    
    for (let i = 1; i < ranges.length; i++) {
        let next = ranges[i];
        if (next.start <= current.end) {
            // Overlap or adjacent
            current.end = Math.max(current.end, next.end);
        } else {
            merged.push(current);
            current = next;
        }
    }
    merged.push(current);

    // Build HTML
    let html = '';
    let lastIdx = 0;
    
    merged.forEach(r => {
        html += escapeHtml(text.substring(lastIdx, r.start));
        html += `<span style="color:#0f0;font-weight:bold;">${escapeHtml(text.substring(r.start, r.end))}</span>`;
        lastIdx = r.end;
    });
    html += escapeHtml(text.substring(lastIdx));
    
    return html;
}

function initHistoryView() {
    if (!historyList || !historyStart || !historyEnd) return;
    if (!historyStart.value || !historyEnd.value) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);
        lastMonth.setDate(lastMonth.getDate() - 1);
        
        historyEnd.valueAsDate = tomorrow;
        historyStart.valueAsDate = lastMonth;
    }
    loadHistoryData();
}

function initVocabView() {
    loadVocabData();
}

async function loadHistoryData() {
    if (!historyList || !historyStart || !historyEnd) return;
    const start = historyStart.value;
    const end = historyEnd.value;
    historyList.innerHTML = '<div style="color:#0f0;">Loading...</div>';
    try {
        const res = await fetch(`/api/history?start_date=${start}&end_date=${end}`);
        historyCache = await res.json();
        renderHistoryList(historyCache);
        if (historyHint) historyHint.textContent = `共 ${historyCache.length} 条历史记录`;
    } catch (err) {
        historyList.innerHTML = `<div style="color:#f00;">Error: ${err.message}</div>`;
    }
}

async function loadVocabData() {
    if (!vocabList) return;
    vocabList.innerHTML = '<div style="color:#0f0;">Loading...</div>';
    try {
        const res = await fetch('/api/check_history');
        vocabCache = await res.json();
        renderVocabList(vocabCache);
        if (vocabHint) vocabHint.textContent = `共 ${vocabCache.length} 个生词`;
    } catch (err) {
        vocabList.innerHTML = `<div style="color:#f00;">Error: ${err.message}</div>`;
    }
}

function renderHistoryList(data) {
    if (!historyList) return;
    historyList.innerHTML = '';
    if (!data || data.length === 0) {
        historyList.innerHTML = '<div style="color:#aaa;">No records found.</div>';
        return;
    }
    const sorted = [...data].sort((a, b) => {
        const ta = new Date(a.timestamp).getTime() || a.timestamp;
        const tb = new Date(b.timestamp).getTime() || b.timestamp;
        return tb - ta;
    });
    sorted.forEach(entry => {
        const div = document.createElement('div');
        div.style.border = '1px solid #050';
        div.style.marginBottom = '10px';
        div.style.padding = '10px';
        let ts = entry.timestamp;
        if (typeof ts === 'number') {
            ts = new Date(ts * 1000).toLocaleString();
        }
        let vocabHtml = '';
        let words = [];
        if (Array.isArray(entry.vocabulary)) {
            words = [...entry.vocabulary];
        } else if (entry.vocabulary && typeof entry.vocabulary === 'object') {
            words = Object.keys(entry.vocabulary);
        }
        if (Array.isArray(entry.vocabulary)) {
            vocabHtml = entry.vocabulary.map(w => `<span style="color:#0f0;font-weight:bold;">${escapeHtml(w)}</span>`).join(', ');
        } else if (entry.vocabulary && typeof entry.vocabulary === 'object') {
            vocabHtml = Object.keys(entry.vocabulary).map(w => {
                const c = entry.vocabulary[w];
                return `<span style="color:#0f0;font-weight:bold;">${escapeHtml(w)}</span> (${c})`;
            }).join(', ');
        }
        const sentenceHtml = highlightSentence(entry.sentence || '', words);
        div.innerHTML = `
            <div style="color:#aaa;font-size:12px;margin-bottom:5px;display:flex;justify-content:space-between;border-bottom:1px dashed #030;padding-bottom:3px;">
                <span>Time: ${ts}</span>
                <span>Source: ${entry.source || 'Unknown'}</span>
            </div>
            <div style="color:#fff;font-size:14px;margin-bottom:5px;">${sentenceHtml}</div>
            <div style="color:#0f0;font-size:12px;">Vocabulary: ${vocabHtml || 'None'}</div>
        `;
        historyList.appendChild(div);
    });
}

function renderVocabList(data) {
    if (!vocabList) return;
    vocabList.innerHTML = '';
    if (!data || data.length === 0) {
        vocabList.innerHTML = '<div style="color:#aaa;">No words found.</div>';
        return;
    }

    data.forEach(item => {
        const word = item && item.word ? String(item.word) : '';
        const count = item && item.count !== undefined ? item.count : '';
        if (!word) return;

        const row = document.createElement('div');
        row.className = 'vocabbook-row';

        const btn = document.createElement('button');
        btn.className = 'vocabbook-trash vocab-delete-btn';
        btn.type = 'button';
        btn.title = 'Delete';
        btn.dataset.word = word;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M9 3h6l1 2h5v2H3V5h5l1-2zm1 6h2v10h-2V9zm4 0h2v10h-2V9zM7 9h2v10H7V9zM6 7h12l-1 14H7L6 7z');
        svg.appendChild(path);
        btn.appendChild(svg);

        const wordSpan = document.createElement('span');
        wordSpan.className = 'vocabbook-word';
        wordSpan.textContent = word;

        const countSpan = document.createElement('span');
        countSpan.className = 'vocabbook-count';
        countSpan.textContent = `(${count})`;

        row.appendChild(btn);
        row.appendChild(wordSpan);
        row.appendChild(countSpan);
        vocabList.appendChild(row);
    });
}

if (historyFilterBtn) {
    historyFilterBtn.addEventListener('click', loadHistoryData);
}

if (historyDownloadBtn) {
    historyDownloadBtn.addEventListener('click', () => {
        if (!historyCache || historyCache.length === 0) {
            alert('No data to download!');
            return;
        }
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(historyCache, null, 2));
        const a = document.createElement('a');
        a.setAttribute('href', dataStr);
        a.setAttribute('download', 'history_export.json');
        document.body.appendChild(a);
        a.click();
        a.remove();
    });
}

if (vocabRefreshBtn) {
    vocabRefreshBtn.addEventListener('click', loadVocabData);
}

if (vocabList) {
    vocabList.addEventListener('click', async (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.vocab-delete-btn') : null;
        if (!btn) return;
        const word = (btn.dataset && btn.dataset.word) ? btn.dataset.word : '';
        if (!word) return;
        btn.disabled = true;
        try {
            const res = await fetch('/api/delete_word', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ word })
            });
            const data = await res.json();
            if (!res.ok) {
                alert(data && data.error ? data.error : 'Delete failed');
                return;
            }
            await loadVocabData();
            if (historyContent && historyContent.style.display !== 'none') {
                await loadHistoryData();
            }
        } catch (err) {
            alert(err.message);
        } finally {
            btn.disabled = false;
        }
    });
}

// Quiz State
let currentQuizData = null;
let currentQuizResults = [];
let currentWordIndex = 0;

// New Event Listeners for Assistant
if (btnSubmit) {
    btnSubmit.addEventListener('click', submitSentence);
}
if (sentenceInput) {
    sentenceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            submitSentence();
        }
    });
}

if (tabLog && tabHistory && tabVocab && logsContent && historyContent && vocabContent) {
    tabLog.addEventListener('click', () => {
        tabLog.style.borderColor = '#0f0';
        tabLog.style.color = '#0f0';
        tabHistory.style.borderColor = '#050';
        tabHistory.style.color = '#050';
        tabVocab.style.borderColor = '#050';
        tabVocab.style.color = '#050';
        logsContent.style.display = 'block';
        historyContent.style.display = 'none';
        vocabContent.style.display = 'none';
        if (historyHint) historyHint.textContent = '';
        if (vocabHint) vocabHint.textContent = '';
    });
    tabHistory.addEventListener('click', () => {
        tabLog.style.borderColor = '#050';
        tabLog.style.color = '#050';
        tabHistory.style.borderColor = '#0f0';
        tabHistory.style.color = '#0f0';
        tabVocab.style.borderColor = '#050';
        tabVocab.style.color = '#050';
        logsContent.style.display = 'none';
        historyContent.style.display = 'flex';
        historyContent.style.flexDirection = 'column';
        vocabContent.style.display = 'none';
        if (historyHint) historyHint.textContent = '加载最近30天历史记录中...';
        initHistoryView();
    });
    tabVocab.addEventListener('click', () => {
        tabLog.style.borderColor = '#050';
        tabLog.style.color = '#050';
        tabHistory.style.borderColor = '#050';
        tabHistory.style.color = '#050';
        tabVocab.style.borderColor = '#0f0';
        tabVocab.style.color = '#0f0';
        logsContent.style.display = 'none';
        historyContent.style.display = 'none';
        vocabContent.style.display = 'flex';
        vocabContent.style.flexDirection = 'column';
        if (historyHint) historyHint.textContent = '';
        if (vocabHint) vocabHint.textContent = '加载生词本中...';
        initVocabView();
    });
}

// Check for autoSentence from server
if (window.autoSentence === undefined || window.autoSentence === null) {
    const autoSentenceScript = document.getElementById('auto-sentence');
    if (autoSentenceScript) {
        try {
            window.autoSentence = JSON.parse(autoSentenceScript.textContent || 'null');
        } catch (e) {
            window.autoSentence = null;
        }
    } else {
        const autoSentenceMeta = document.querySelector('meta[name="auto-sentence"]');
        if (autoSentenceMeta) {
            try {
                window.autoSentence = JSON.parse(autoSentenceMeta.getAttribute('content') || 'null');
            } catch (e) {
                window.autoSentence = null;
            }
        }
    }
}
if (window.autoSentence === undefined || window.autoSentence === null || window.autoSentence === '') {
    try {
        const params = new URLSearchParams(window.location.search);
        let urlSentence = params.get('auto_sentence');
        if (!urlSentence) urlSentence = params.get('auto_sentance');
        if (urlSentence) window.autoSentence = urlSentence;
    } catch (e) {
        // ignore
    }
}
if (window.autoSentence && sentenceInput && !window.__autoSentenceDidSubmit) {
    window.__autoSentenceDidSubmit = true;
    sentenceInput.value = String(window.autoSentence).replace(/[\r\n]+/g, ' ').trim();
    sentenceInput.focus();
    setTimeout(() => {
        if (btnSubmit) {
            btnSubmit.click();
        } else {
            submitSentence();
        }
    }, 0);
}

async function submitSentence() {
    if (!sentenceInput) return;
    const sentence = sentenceInput.value.trim();
    if (!sentence) return;

    // UI Feedback
    if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '[ 分析中... ]';
    }
    
    // Show staging area
    if (stagingArea) {
        stagingArea.style.display = 'block';
        stagingArea.textContent = sentence;
        stagingArea.style.color = '#0f0'; // Normal color
    }
    
    // Clear log area
    if (logsContent) logsContent.innerHTML = '';
    
    // Clear token stats if any
    const existingStats = document.getElementById('token-stats');
    if (existingStats) existingStats.remove();

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
                // Show Token Stats
                if (data.token_usage) {
                    showTokenStats(data.token_usage);
                }
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
        if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.innerHTML = '[ 提交识别 ]';
        }
        if (sentenceInput) sentenceInput.value = '';
    }
}

function showTokenStats(usage) {
    // usage: { total_tokens, completion_tokens, prompt_tokens }
    // Insert next to "日志" label in #log-area
    
    // Find the log area header div
    const logHeader = document.querySelector('#log-area > div:first-child');
    if (logHeader) {
        // Create stats span
        const statsSpan = document.createElement('span');
        statsSpan.id = 'token-stats';
        statsSpan.style.float = 'right';
        statsSpan.style.fontSize = '12px';
        statsSpan.style.color = '#aaa';
        
        statsSpan.innerHTML = `Tokens: Total ${usage.total_tokens || 0} (Prompt ${usage.prompt_tokens || 0}, Completion ${usage.completion_tokens || 0})`;
        
        logHeader.appendChild(statsSpan);
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
    if (!logsContent) return;
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
    
    if (logsContent) logsContent.innerHTML = '<div class="log-entry" style="color:#0f0;">Submitting results...</div>';
    
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
    if (!logsContent) return;
    logsContent.innerHTML = '';
    
    // 1. Show Sentence in logs
    addLogEntry(currentQuizData.sentence, "user");
    
    // 2. Show Staging Area (highlight wrong words if any)
    if (stagingArea) {
        let sentenceHtml = currentQuizData.sentence;
        const wrongWords = currentQuizResults.filter(r => !r.isCorrect).map(r => r.word);
        
        // Simple replace for highlighting (case insensitive)
        wrongWords.forEach(w => {
            const regex = new RegExp(`\\b${w}\\b`, 'gi');
            sentenceHtml = sentenceHtml.replace(regex, `<span style="color:#f00; border-bottom:1px dashed #f00;">$&</span>`);
        });
        
        stagingArea.innerHTML = sentenceHtml;
        stagingArea.style.color = wrongWords.length > 0 ? '#fff' : '#0f0';
    }
    
    // 3. Show Result Log
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    let html = `<div class="log-sentence" style="color: #fff;">Analysis Result:</div>`;
    
    if (currentQuizData.words.length > 0) {
        html += `<div class="vocab-list">Difficult Words (IELTS): `;
        currentQuizData.words.forEach(w => {
            // Find if this word was answered incorrectly
            // But currentQuizResults might not have it if quiz was interrupted or something
            // But we assume full completion here.
            const result = currentQuizResults.find(r => r.word === w.word);
            const isWrong = result && !result.isCorrect;
            
            const style = isWrong ? 'color:#f00; border-bottom:1px solid #f00; font-weight:bold;' : 'color:#0f0; font-weight:bold;';
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
    if (!logsContent) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    if (type === "user") {
        entry.innerHTML = `<div class="log-sentence" style="color: #0f0;">> ${text}</div>`;
    } else {
        entry.innerHTML = `<div class="log-sentence" style="color: #f00;">System: ${text}</div>`;
    }
    
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
