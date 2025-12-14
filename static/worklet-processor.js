class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.buffer = new Float32Array(0);
    // Target buffer: ~50ms
    // Max buffer: ~0.5s. If exceeded, drop data to catch up.
    this.maxQueueLength = 10; // Assuming chunks are ~46ms each
    this.lastTimestamp = 0;
    
    this.port.onmessage = e => {
      const msg = e.data;
      // Msg format: { timestamp: number, audioData: Float32Array }
      if (msg && msg.audioData) {
        // Order Check:
        // Ensure strictly increasing timestamp (or at least not old)
        // Note: For simple streaming, we assume source is monotonic.
        if (msg.timestamp < this.lastTimestamp) {
            // Out of order packet! Drop it.
            // console.log("Dropped out-of-order packet");
            return;
        }
        this.lastTimestamp = msg.timestamp;

        this.queue.push(msg.audioData);
        
        // Latency Control: Drop old packets if queue is too long
        // This ensures "received stream < 0.7s" constraint
        if (this.queue.length > this.maxQueueLength) {
            // Keep only the last few packets
            const dropCount = this.queue.length - 2; 
            this.queue = this.queue.slice(dropCount);
        }
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    let offset = 0;
    while (offset < out.length) {
      if (this.buffer.length === 0) {
        if (this.queue.length === 0) {
          // Underrun: silence
          while (offset < out.length) {
            out[offset++] = 0;
          }
          break;
        } else {
          this.buffer = this.queue.shift();
        }
      }
      const need = out.length - offset;
      const avail = this.buffer.length;
      const n = Math.min(need, avail);
      out.set(this.buffer.subarray(0, n), offset);
      this.buffer = this.buffer.subarray(n);
      offset += n;
    }
    return true;
  }
}
registerProcessor('pcm-player', PCMPlayerProcessor);
