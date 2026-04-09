import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Judge Arena — Reproducible LLM Evaluation';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        {/* Subtle gradient accent */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'radial-gradient(ellipse at 30% 20%, rgba(230,81,0,0.15) 0%, transparent 50%)',
            display: 'flex',
          }}
        />

        {/* Icon */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 88,
            height: 88,
            borderRadius: 20,
            backgroundColor: '#E65100',
            marginBottom: 32,
          }}
        >
          {/* Scales icon (simplified for OG) */}
          <svg
            width="52"
            height="52"
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="16" cy="6" r="2" fill="white" />
            <line x1="16" y1="8" x2="16" y2="25" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="6" y1="10" x2="26" y2="10" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="8" y1="10" x2="8" y2="16" stroke="white" strokeWidth="2" strokeLinecap="round" />
            <line x1="24" y1="10" x2="24" y2="16" stroke="white" strokeWidth="2" strokeLinecap="round" />
            <path d="M4 16 Q8 22 12 16" stroke="white" strokeWidth="2" strokeLinecap="round" fill="none" />
            <path d="M20 16 Q24 22 28 16" stroke="white" strokeWidth="2" strokeLinecap="round" fill="none" />
            <line x1="11" y1="25" x2="21" y2="25" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </div>

        {/* Title */}
        <div
          style={{
            display: 'flex',
            fontSize: 56,
            fontWeight: 800,
            color: '#f1f5f9',
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
          }}
        >
          Judge Arena
        </div>

        {/* Subtitle */}
        <div
          style={{
            display: 'flex',
            fontSize: 22,
            color: '#94a3b8',
            marginTop: 16,
            letterSpacing: '-0.01em',
          }}
        >
          Reproducible LLM Evaluation Studio
        </div>

        {/* Feature pills */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            marginTop: 40,
          }}
        >
          {['Self-Hosted', 'Versioned Rubrics', 'Multi-Model', 'Human Review'].map(
            (label) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  padding: '8px 20px',
                  borderRadius: 99,
                  border: '1px solid rgba(255,255,255,0.1)',
                  backgroundColor: 'rgba(255,255,255,0.04)',
                  color: '#cbd5e1',
                  fontSize: 16,
                  fontWeight: 500,
                }}
              >
                {label}
              </div>
            )
          )}
        </div>

        {/* Domain */}
        <div
          style={{
            position: 'absolute',
            bottom: 32,
            display: 'flex',
            fontSize: 16,
            color: '#64748b',
          }}
        >
          judgearena.com
        </div>
      </div>
    ),
    { ...size }
  );
}
