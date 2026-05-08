'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import { HedgehogModeRenderer, HedgeHogMode } from '@posthog/hedgehog-mode'
import { insforge } from '@/lib/insforge'
import { blobToWav } from '@/lib/wav'

type Phase = 'idle' | 'recording' | 'processing' | 'review' | 'submitting' | 'submitted' | 'error'

const CHAT_COLORS = ['#F54E00', '#1D4AFF', '#DC9300', '#16A34A', '#9333EA', '#0891B2']

type Submission = {
  id: string
  username: string
  transcription: string | null
  wav_url: string
  created_at: string
}

export default function Home() {
  const [username, setUsername] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [timeLeft, setTimeLeft] = useState(5)
  const [transcription, setTranscription] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [, setGame] = useState<HedgeHogMode | null>(null)

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [waveform, setWaveform] = useState<number[]>([])
  const [reviewPlaying, setReviewPlaying] = useState(false)
  const [reviewProgress, setReviewProgress] = useState(0)
  const [transcribing, setTranscribing] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pendingWavRef = useRef<{ blob: Blob; fileName: string } | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const reviewAudioRef = useRef<HTMLAudioElement | null>(null)
  const reviewRafRef = useRef<number | null>(null)

  useEffect(() => {
    loadSubmissions()
    return () => {
      audioRef.current?.pause()
      reviewAudioRef.current?.pause()
      if (reviewRafRef.current) cancelAnimationFrame(reviewRafRef.current)
    }
  }, [])

  function toggleReviewPlay() {
    const audio = reviewAudioRef.current
    if (!audio) return
    if (reviewPlaying) {
      audio.pause()
      if (reviewRafRef.current) cancelAnimationFrame(reviewRafRef.current)
      setReviewPlaying(false)
    } else {
      audio.play()
      setReviewPlaying(true)
      const tick = () => {
        if (!audio || audio.paused) return
        setReviewProgress(audio.currentTime / (audio.duration || 1))
        reviewRafRef.current = requestAnimationFrame(tick)
      }
      reviewRafRef.current = requestAnimationFrame(tick)
    }
  }

  function seekReview(e: React.MouseEvent<HTMLDivElement>) {
    const audio = reviewAudioRef.current
    if (!audio) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    audio.currentTime = ratio * (audio.duration || 0)
    setReviewProgress(ratio)
  }

  function toggleExpanded(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function togglePlay(id: string, url: string) {
    if (playingId === id) {
      audioRef.current?.pause()
      setPlayingId(null)
    } else {
      audioRef.current?.pause()
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => setPlayingId(null)
      audio.play()
      setPlayingId(id)
    }
  }

  async function loadSubmissions() {
    const { data } = await insforge.database.from('submissions').select('*')
    if (data) {
      const sorted = (data as Submission[])
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 20)
      setSubmissions(sorted)
      setExpandedIds(new Set(sorted.map(s => s.id)))
    }
  }

  const stopRecording = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }, [])

  const startRecording = useCallback(async () => {
    if (!username.trim()) {
      setErrorMsg('Enter a username first')
      return
    }
    setErrorMsg('')

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch {
      setErrorMsg('Microphone access denied')
      return
    }

    chunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : ''

    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    mediaRecorderRef.current = mr

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      await processAudio(chunksRef.current, mr.mimeType)
    }

    mr.start(100)
    setPhase('recording')
    setTimeLeft(5)

    let t = 5
    intervalRef.current = setInterval(() => {
      t -= 1
      setTimeLeft(t)
      if (t <= 0) stopRecording()
    }, 1000)
  }, [username, stopRecording])

  async function processAudio(chunks: Blob[], mimeType: string) {
    setPhase('processing')
    try {
      const rawBlob = new Blob(chunks, { type: mimeType || 'audio/webm' })
      const { wav: wavBlob, waveform: waveData } = await blobToWav(rawBlob)

      const safeName = username.replace(/[^a-z0-9]/gi, '_').toLowerCase()
      const fileName = `${Date.now()}-${safeName}.wav`
      pendingWavRef.current = { blob: wavBlob, fileName }
      setWaveform(waveData)

      // Set up preview audio and show review immediately
      reviewAudioRef.current?.pause()
      const url = URL.createObjectURL(wavBlob)
      const previewAudio = new Audio(url)
      previewAudio.onended = () => {
        setReviewPlaying(false)
        setReviewProgress(1)
      }
      reviewAudioRef.current = previewAudio
      setReviewProgress(0)
      setTranscription('')
      setTranscribing(true)
      setPhase('review')

      // Transcribe in background using the original blob (correct MIME type → correct Groq filename)
      const formData = new FormData()
      const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('ogg') ? 'ogg' : 'wav'
      formData.append('audio', rawBlob, `recording.${ext}`)
      const transcribeRes = await fetch('/api/transcribe', { method: 'POST', body: formData })
      const transcribeJson = await transcribeRes.json()
      setTranscription(transcribeJson.text ?? '')
      setTranscribing(false)
    } catch (err) {
      console.error(err)
      setTranscribing(false)
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      setPhase('error')
    }
  }

  async function submitRecording() {
    if (!pendingWavRef.current) return
    const { blob: wavBlob, fileName } = pendingWavRef.current
    setPhase('submitting')
    try {
      const { data: uploadData, error: uploadError } = await insforge.storage
        .from('voice-recordings')
        .upload(fileName, wavBlob)

      if (uploadError) throw new Error(String(uploadError))

      const wavKey = (uploadData as { key: string; url: string }).key
      const wavUrl = (uploadData as { key: string; url: string }).url

      await insforge.database.from('submissions').insert([{
        username: username.trim(),
        wav_key: wavKey,
        wav_url: wavUrl,
        transcription,
      }])

      pendingWavRef.current = null
      setPhase('submitted')
      await loadSubmissions()
    } catch (err) {
      console.error(err)
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      setPhase('error')
    }
  }

  const reset = () => {
    reviewAudioRef.current?.pause()
    if (reviewRafRef.current) cancelAnimationFrame(reviewRafRef.current)
    reviewAudioRef.current = null
    setReviewPlaying(false)
    setReviewProgress(0)
    setWaveform([])
    setPhase('idle')
    setTimeLeft(5)
    setTranscription('')
    setErrorMsg('')
    pendingWavRef.current = null
  }

  const progress = (timeLeft / 5) * 100

  return (
    <main className="min-h-screen bg-ph-bg">

      {/* Nav bar */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-dashed border-ph-divider">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-ph-red rounded-sm" />
          <span className="font-bold text-ph-text text-sm tracking-tight">TD Recorder</span>
        </div>
        <span className="text-xs text-ph-gray font-mono">thanks.dylan</span>
      </nav>

      {/* Hero */}
      <section className="max-w-3xl mx-auto px-6 pt-12 pb-8 flex flex-col md:flex-row items-center gap-10">
        {/* Text side */}
        <div className="flex-1 text-center md:text-left">

          <h1 className="text-5xl md:text-6xl font-black tracking-tight leading-none mb-4" style={{ color: 'rgba(21,21,21,0.9)' }}>
            {' '}
            <span className="text-ph-red">&ldquo;thanks</span>
            <br />
            <span className="text-ph-red">dylan&rdquo;</span>
            <br />
            <span className="text-ph-red">recorder</span>
          </h1>

          <p className="text-ph-text/60 text-base max-w-xs md:max-w-none leading-relaxed">
            record a shoutout for a music project.
          </p>
        </div>

        {/* Presenter image — click to meep */}
        <div className="flex-shrink-0 flex flex-col items-center gap-2">
          <button
            onClick={() => new Audio('/meep.mp3').play()}
            className="group relative transition-transform active:scale-95 hover:-translate-y-1 duration-150"
            title="Click me!"
          >
            <Image
              src="/presenter.png"
              alt="PostHog presenter hedgehog"
              width={180}
              height={200}
              priority
              className="drop-shadow-md group-hover:drop-shadow-xl transition-all duration-150"
            />
          </button>
          <span className="text-ph-text/30 text-xs font-medium tracking-wide animate-pulse">
            it meeps ↑
          </span>
        </div>
      </section>

      {/* Dashed divider */}
      <div className="max-w-3xl mx-auto px-6">
        <div className="border-t border-dashed border-ph-divider" />
      </div>

      {/* Recorder */}
      <section className="max-w-3xl mx-auto px-6 py-10 flex flex-col items-center gap-5">
        {/* Username input */}
        <div className="w-full max-w-sm">
          <label className="block text-xs font-semibold text-ph-text/50 uppercase tracking-widest mb-2 text-center">
            add a name
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. spiderhog"
            disabled={phase === 'recording' || phase === 'processing'}
            maxLength={30}
            className="w-full bg-white border border-ph-divider rounded-xl px-4 py-3 text-ph-text placeholder-ph-gray text-center text-base focus:outline-none focus:border-ph-red/50 focus:ring-2 focus:ring-ph-red/10 transition-all disabled:opacity-40"
          />
        </div>

        {errorMsg && (
          <p className="text-ph-red text-sm font-medium">{errorMsg}</p>
        )}

        {/* Record states */}
        {(phase === 'idle' || phase === 'error') && (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={startRecording}
              className="group w-24 h-24 rounded-full flex items-center justify-center transition-all duration-150 active:scale-95"
              style={{
                backgroundColor: '#F54E00',
                boxShadow: '0 0 0 0 rgba(245,78,0,0.4)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = '0 8px 30px rgba(245,78,0,0.35)'
                e.currentTarget.style.transform = 'translateY(-2px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = '0 0 0 0 rgba(245,78,0,0.4)'
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zm7 9a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.93V20H9a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2h-2v-2.07A7 7 0 0 0 19 11z" />
              </svg>
            </button>
            <span className="text-ph-text/40 text-xs">tap to record</span>
          </div>
        )}

        {phase === 'recording' && (
          <div className="flex flex-col items-center gap-4">
            <button
              onClick={stopRecording}
              className="w-24 h-24 rounded-full flex items-center justify-center animate-pulse"
              style={{ backgroundColor: '#F54E00', boxShadow: '0 0 40px rgba(245,78,0,0.4)' }}
            >
              <div className="w-8 h-8 bg-white rounded-md" />
            </button>
            {/* Progress bar */}
            <div className="flex items-center gap-3">
              <div className="w-40 h-1 bg-ph-accent rounded-full overflow-hidden border border-ph-divider">
                <div
                  className="h-full rounded-full transition-all duration-1000 ease-linear"
                  style={{ width: `${progress}%`, backgroundColor: '#F54E00' }}
                />
              </div>
              <span className="text-ph-red font-mono text-sm font-bold w-5">{timeLeft}s</span>
            </div>
            <span className="text-ph-text/40 text-xs">tap square to stop early</span>
          </div>
        )}

        {phase === 'processing' && (
          <div className="flex flex-col items-center gap-3">
            <div className="w-24 h-24 rounded-full border-2 border-ph-accent border-t-ph-red animate-spin" />
            <p className="text-ph-text/50 text-sm">Transcribing with Whisper…</p>
          </div>
        )}

        {phase === 'review' && (
          <div className="flex flex-col items-center gap-4 w-full max-w-sm">
            {/* Waveform player card */}
            <div className="w-full bg-white border border-ph-divider rounded-2xl p-4">
              {/* Waveform bars */}
              <div
                className="flex items-center gap-px h-14 cursor-pointer mb-3 select-none"
                onClick={seekReview}
                title="Click to seek"
              >
                {waveform.map((amp, i) => {
                  const played = reviewProgress > i / waveform.length
                  return (
                    <div
                      key={i}
                      className="flex-1 rounded-sm transition-colors duration-75"
                      style={{
                        height: `${Math.max(10, amp * 100)}%`,
                        backgroundColor: played ? '#F54E00' : '#D0D1C9',
                        opacity: played ? 1 : 0.5,
                      }}
                    />
                  )
                })}
              </div>

              {/* Play controls */}
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleReviewPlay}
                  className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all active:scale-95"
                  style={{ backgroundColor: '#F54E00' }}
                >
                  {reviewPlaying ? (
                    <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5 text-white translate-x-px" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-ph-text/40 text-xs uppercase tracking-widest font-semibold mb-0.5">you said</p>
                  {transcribing ? (
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-ph-red animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-ph-red animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-ph-red animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  ) : (
                    <p className="text-ph-text text-sm font-medium leading-snug truncate">
                      {transcription || <span className="text-ph-gray italic">nothing detected</span>}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-3">
              <button
                onClick={submitRecording}
                className="px-6 py-2.5 rounded-xl text-white text-sm font-semibold transition-all active:scale-95"
                style={{ backgroundColor: '#F54E00' }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9' }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}
              >
                Submit to wall
              </button>
              <button
                onClick={reset}
                className="px-4 py-2.5 rounded-xl text-ph-text/50 hover:text-ph-text text-sm font-medium border border-ph-divider hover:border-ph-text/20 transition-colors"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {phase === 'submitting' && (
          <div className="flex flex-col items-center gap-3">
            <div className="w-24 h-24 rounded-full border-2 border-ph-accent border-t-ph-red animate-spin" />
            <p className="text-ph-text/50 text-sm">Saving to wall…</p>
          </div>
        )}

        {phase === 'submitted' && (
          <div className="flex flex-col items-center gap-4 w-full max-w-sm">
            <div className="w-full bg-white border border-ph-divider rounded-2xl p-5 text-center">
              <p className="text-ph-red text-xs uppercase tracking-widest mb-2 font-semibold">on the wall ✓</p>
              <p className="text-ph-text text-lg font-medium leading-snug">
                {transcription || <span className="text-ph-gray italic text-base">audio message saved</span>}
              </p>
            </div>
            <button
              onClick={reset}
              className="text-ph-red/80 hover:text-ph-red text-sm font-semibold transition-colors"
            >
              Record again
            </button>
          </div>
        )}
      </section>

      {/* Shoutout wall */}
      {submissions.length > 0 && (
        <section className="max-w-3xl mx-auto px-6 pb-24">
          <div className="flex items-center gap-4 mb-4">
            <div className="flex-1 border-t border-dashed border-ph-divider" />
            <span className="text-ph-text/30 text-xs font-semibold uppercase tracking-widest">Shoutout Wall</span>
            <div className="flex-1 border-t border-dashed border-ph-divider" />
          </div>

          {/* Chat log */}
          <div className="flex flex-col gap-1">
            {submissions.map((s, i) => {
              const color = CHAT_COLORS[i % CHAT_COLORS.length]
              const expanded = expandedIds.has(s.id)
              const playing = playingId === s.id
              return (
                <div key={s.id} className="submission-card group">
                  {expanded ? (
                    /* ── Expanded: iMessage-style bubble ── */
                    <div className="flex items-start gap-2.5 py-1">
                      {/* Avatar */}
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-black flex-shrink-0 mt-4 shadow-sm"
                        style={{ backgroundColor: color }}
                      >
                        {s.username[0]?.toUpperCase() ?? '?'}
                      </div>

                      {/* Username + bubble */}
                      <div className="flex-1 min-w-0">
                        {/* Username row */}
                        <div className="flex items-center gap-1.5 mb-1 px-1">
                          <button
                            onClick={() => toggleExpanded(s.id)}
                            className="text-ph-gray/50 hover:text-ph-text text-xs font-mono leading-none transition-colors flex-shrink-0"
                            title="Collapse"
                          >
                            [−]
                          </button>
                          <span className="text-xs font-bold tracking-wide" style={{ color }}>
                            {s.username}
                          </span>
                        </div>

                        {/* Bubble */}
                        <div
                          className="rounded-2xl rounded-tl-md px-4 py-3 max-w-sm"
                          style={{ backgroundColor: `${color}14` }}
                        >
                          <p className="text-ph-text/80 text-sm leading-relaxed">
                            {s.transcription || <span className="italic text-ph-gray">no transcription</span>}
                          </p>

                          {/* Play row inside bubble */}
                          <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-black/5">
                            <button
                              onClick={() => togglePlay(s.id, s.wav_url)}
                              className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 transition-all active:scale-95"
                              style={playing
                                ? { backgroundColor: color, color: 'white' }
                                : { backgroundColor: `${color}25`, color }
                              }
                              title={playing ? 'Pause' : 'Play'}
                            >
                              {playing ? (
                                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
                                  <rect x="6" y="4" width="4" height="16" rx="1" />
                                  <rect x="14" y="4" width="4" height="16" rx="1" />
                                </svg>
                              ) : (
                                <svg className="w-2.5 h-2.5 translate-x-px" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M8 5v14l11-7z" />
                                </svg>
                              )}
                            </button>
                            <span
                              className="text-xs font-medium"
                              style={{ color: playing ? color : '#BFBFBC' }}
                            >
                              {playing ? 'playing…' : 'voice message'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* ── Collapsed: Reddit-style single line ── */
                    <button
                      onClick={() => toggleExpanded(s.id)}
                      className="w-full flex items-center gap-2 py-1 group/line"
                      title={`Expand ${s.username}`}
                    >
                      <span className="text-ph-gray/60 font-mono text-xs group-hover/line:text-ph-gray transition-colors">[+]</span>
                      <div
                        className="flex-1 h-px rounded-full opacity-30 group-hover/line:opacity-60 transition-opacity"
                        style={{ backgroundColor: color }}
                      />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Rolling hedgehog */}
      <HedgehogModeRenderer
        config={{
          assetsUrl: '/assets',
          platforms: {
            selector: 'h1, .submission-card, nav',
            viewportPadding: { top: 64 },
          },
        }}
        onGameReady={setGame}
      />
    </main>
  )
}
