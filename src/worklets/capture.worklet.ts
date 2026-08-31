// AudioWorklet capture processor — runs off main thread, streams PCM in
// small frames (20-100ms) for low-latency STT. Frame size is configurable
// via processorOptions.frameSize (default 1024 = 64ms @16k).
// ponytail: global processor, no per-instance lock — one ctx = one processor

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const AudioWorkletProcessor: any;
declare function registerProcessor(name: string, ctor: unknown): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private frameSize: number;
  private buf: Float32Array;
  private off = 0;
  constructor(options?: { processorOptions?: { frameSize?: number } }) {
    super();
    this.frameSize = options?.processorOptions?.frameSize ?? 1024;
    this.buf = new Float32Array(this.frameSize);
  }
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.off++] = ch[i]!;
      if (this.off >= this.frameSize) {
        // copy before transfer — worklet memory must not be neutered
        this.port.postMessage(this.buf.slice(0));
        this.buf = new Float32Array(this.frameSize);
        this.off = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
export {};
