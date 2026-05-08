CREATE TABLE submissions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  username text NOT NULL,
  wav_key text NOT NULL,
  wav_url text NOT NULL,
  transcription text,
  created_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_insert_submissions"
ON submissions FOR INSERT TO anon
WITH CHECK (true);

CREATE POLICY "anon_select_submissions"
ON submissions FOR SELECT TO anon
USING (true);

-- Allow anon to upload WAV files to the voice-recordings storage bucket
CREATE POLICY "anon_upload_voice_recordings"
ON storage.objects FOR INSERT TO anon
WITH CHECK (bucket = 'voice-recordings');

-- Allow anyone to read from the public voice-recordings bucket
CREATE POLICY "public_read_voice_recordings"
ON storage.objects FOR SELECT TO anon
USING (bucket = 'voice-recordings');

GRANT SELECT, INSERT ON storage.objects TO anon;
GRANT USAGE ON SCHEMA storage TO anon;
