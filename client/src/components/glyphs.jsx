/*
 * Every mark in the app. The music symbols are real glyphs from Google's Noto
 * Music face (loaded, subset to just these characters, in index.html) rather
 * than drawn here -- a typeface's notes are engraved properly, and they take
 * the colour and size of whatever they sit in like any other text. The
 * interface icons are plain stroke SVG.
 */

const musicGlyph = (char) => function MusicGlyph({ className = '', style }) {
  return <span className={`music-glyph ${className}`} style={style} aria-hidden="true">{char}</span>;
};

export const EighthNote = musicGlyph('♪');   // ♪
export const BeamedNotes = musicGlyph('♫');  // ♫
export const Sixteenths = musicGlyph('♬');   // ♬
export const Sharp = musicGlyph('♯');        // ♯
export const Flat = musicGlyph('♭');         // ♭

/** The level-meter bars that have always been the logo. */
export function LogoBars({ className = '', count = 3 }) {
  return (
    <span className={`logo-bars ${className}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <i key={i} />)}
    </span>
  );
}

/* The four answer marks, in card order. A card is its colour *and* its mark,
   so nobody is relying on hue alone to tell them apart -- and "the sharp one"
   is easy to say out loud. */
export const CHOICE_MARKS = [
  { Glyph: EighthNote, name: 'eighth note', tone: 'tangerine' },
  { Glyph: BeamedNotes, name: 'beamed notes', tone: 'aqua' },
  { Glyph: Sharp, name: 'sharp', tone: 'butter' },
  { Glyph: Flat, name: 'flat', tone: 'rose' }
];

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true'
};

export const PlayIcon = (p) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M8 4.8v14.4l11.5-7.2z" fill="currentColor" /></svg>
);
export const PlusIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="3" {...stroke} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const ArrowIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="3" {...stroke} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const CheckIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="3.2" {...stroke} {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const CrossIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="2.8" {...stroke} {...p}><path d="M7 7l10 10M17 7L7 17" /></svg>
);
export const CopyIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="2.4" {...stroke} {...p}>
    <rect x="8" y="8" width="12" height="12" rx="3" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);
export const ShareIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="2.6" {...stroke} {...p}>
    <path d="M12 15V3M7 8l5-5 5 5" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </svg>
);
export const UpIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="3.2" {...stroke} {...p}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
);
export const DownIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="3.2" {...stroke} {...p}><path d="M12 5v14M6 13l6 6 6-6" /></svg>
);
export const KeyboardIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="2.4" {...stroke} {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="3" />
    <path d="M6.5 10h1M10.5 10h1M14.5 10h1M8 14h8" />
  </svg>
);
export const GridIcon = (p) => (
  <svg viewBox="0 0 24 24" strokeWidth="2.4" {...stroke} {...p}>
    <rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="8" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" />
  </svg>
);
export const CrownIcon = (p) => (
  <svg viewBox="0 0 30 20" aria-hidden="true" {...p}><path d="M3 17L1 4l8 6 6-9 6 9 8-6-2 13z" fill="currentColor" /></svg>
);

export function VolumeIcon({ level, ...p }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="2.2" {...stroke} {...p}>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      {level === 'off' && <path d="M17 9.5l5 5M22 9.5l-5 5" />}
      {level !== 'off' && <path d="M16.5 8.5a5 5 0 0 1 0 7" />}
      {level === 'high' && <path d="M19.2 5.8a9 9 0 0 1 0 12.4" />}
    </svg>
  );
}
