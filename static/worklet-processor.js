class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.buffer = new Float32Array(0);
    // 最多缓冲约200ms的音频，超过则丢弃旧数据以保持实时性
    this.maxBufferedSamples = Math.floor(sampleRate * 0.2);
    this.port.onmessage = e => {
      const data = e.data;
      if (data && data.length) {
        // 计算当前待播放的样本数量
        let pending = this.buffer.length;
        for (let i = 0; i < this.queue.length; i++) pending += this.queue[i].length;
        if (pending > this.maxBufferedSamples) {
          // 积压过多：直接清空旧队列，仅保留最新数据，实现“追帧”
          this.buffer = new Float32Array(0);
          this.queue = [data];
        } else {
          this.queue.push(data);
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
