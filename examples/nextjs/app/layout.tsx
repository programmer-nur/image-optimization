import type { ReactNode } from 'react';

export const metadata = {
  title: 'imgopt example',
  description: 'Hero, gallery, and avatar cases against the image optimization service.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          margin: 0,
          padding: '2rem',
          maxWidth: 1400,
          marginInline: 'auto',
        }}
      >
        <nav style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
          <a href="/">Hero</a>
          <a href="/gallery">Gallery</a>
          <a href="/avatars">Avatars</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
