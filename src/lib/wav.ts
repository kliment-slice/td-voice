export type WavResult = { wav: Blob; waveform: number[] }

export async function blobToWav(blob: Blob): Promise<WavResult> {
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
    const wav = new Blob([encodeWav(audioBuffer)], { type: 'audio/wav' })
    const waveform = extractWaveform(audioBuffer, 80)
    return { wav, waveform }
  } finally {
    await audioCtx.close()
  }
}

function extractWaveform(audioBuffer: AudioBuffer, samples: number): number[] {
  const data = audioBuffer.getChannelData(0)
  const blockSize = Math.floor(data.length / samples)
  const points: number[] = []
  for (let i = 0; i < samples; i++) {
    let sum = 0
    const start = i * blockSize
    for (let j = 0; j < blockSize; j++) sum += Math.abs(data[start + j])
    points.push(sum / blockSize)
  }
  const max = Math.max(...points, 0.001)
  return points.map(v => v / max)
}

function encodeWav(audioBuffer: AudioBuffer): ArrayBuffer {
  const sampleRate = audioBuffer.sampleRate
  const numSamples = audioBuffer.length
  const dataSize = numSamples * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)

  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  str(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, dataSize, true)

  const ch = audioBuffer.getChannelData(0)
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true)
  }

  return buf
}
