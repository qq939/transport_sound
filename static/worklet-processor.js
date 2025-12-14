class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.buffer = new Float32Array(0);
    this.port.onmessage = e => {
      const data = e.data;
      if (data && data.length) {
        this.queue.push(data);
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    let offset = 0;
    while (offset < out.length) {
      if (this.buffer.length === 0) {
        if (this.queue.length === 0) {
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
