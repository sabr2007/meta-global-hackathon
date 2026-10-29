// Push-to-talk: record the microphone, hand back a 16 kHz mono 16-bit WAV for Muse Voice Transcribe.

const TARGET_RATE = 16_000;
const MAX_SECONDS = 20;

export interface Recording {
  stop(): Promise<Blob>;
  cancel(): void;
  level(): number; // 0..1, for the button's meter
}

function downsample(chunks: Float32Array[], from: number): Int16Array {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  const ratio = from / TARGET_RATE;
  const out = new Int16Array(Math.floor(length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    // average the source samples that fall into this output sample (a cheap low-pass)
    const start = Math.floor(i * ratio);
    const end = Math.min(length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += joined[j];
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

function wav(samples: Int16Array): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string): void => [...value].forEach((ch, i) => header.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  header.setUint32(4, 36 + samples.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, TARGET_RATE, true);
  header.setUint32(28, TARGET_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, samples.byteLength, true);
  return new Blob([header.buffer, samples.buffer as ArrayBuffer], { type: 'audio/wav' });
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let peak = 0;
  processor.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let max = 0;
    for (const v of data) max = Math.max(max, Math.abs(v));
    peak = Math.max(max, peak * 0.85);
    if (chunks.length * 4096 > context.sampleRate * MAX_SECONDS) processor.onaudioprocess = null;
  };
  source.connect(processor);
  processor.connect(context.destination);
  const close = (): void => {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void context.close();
  };
  return {
    async stop() {
      close();
      return wav(downsample(chunks, context.sampleRate));
    },
    cancel: close,
    level: () => Math.min(1, peak * 3),
  };
}
