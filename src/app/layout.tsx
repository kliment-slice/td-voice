import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Thanks Dylan',
  description: 'Leave a voice shoutout for Dylan',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ph-bg antialiased">{children}</body>
    </html>
  )
}
