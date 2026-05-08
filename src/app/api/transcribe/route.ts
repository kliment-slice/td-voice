import { NextRequest, NextResponse } from 'next/server'

const GROQ_URL = 'https://api.groq.com/openai/v1'

async function groq(path: string, body: unknown) {
  const res = await fetch(`${GROQ_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_WHISPER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

async function transcribe(file: File): Promise<string> {
  // Preserve the original filename/extension so Groq detects the format correctly
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('model', 'whisper-large-v3-turbo')

  const res = await fetch(`${GROQ_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_WHISPER_KEY}` },
    body: form,
  })
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json()
  return data.text ?? ''
}

async function censorProfanity(text: string): Promise<string> {
  if (!text.trim()) return text
  const data = await groq('/chat/completions', {
    model: 'openai/gpt-oss-20b',
    messages: [
      {
        role: 'system',
        content:
          'You are a content moderator. Replace any profanity in the text with a censored version by replacing one letter with an asterisk (e.g. "fuck" → "f*ck", "shit" → "sh*t", "ass" → "a*s"). Do not change anything else. Return ONLY the (possibly modified) text with no explanation, quotes, or extra punctuation.',
      },
      { role: 'user', content: text },
    ],
    temperature: 0,
  })
  return data.choices?.[0]?.message?.content?.trim() ?? text
}

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const file = formData.get('audio') as File | null
  if (!file) return NextResponse.json({ error: 'No audio' }, { status: 400 })

  try {
    const raw = await transcribe(file)
    const text = await censorProfanity(raw)
    return NextResponse.json({ text, raw })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
