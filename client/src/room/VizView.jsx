import { useEffect, useRef } from 'react';
import Visualizer from '../lib/Visualizer.js';

/**
 * The radial meter and the disc at its centre.
 *
 * The canvas is the visualiser's; the disc is ordinary markup laid over it, so
 * the clock digits stay crisp text and the artwork can cross-fade. The disc
 * is a record: grooves while the clock runs, the album art as its label at
 * the reveal. It is a fixed circle either way, so nothing moves when one
 * becomes the other.
 */
export default function VizView({ attach, timer, glyph, urgent, caption, artwork, revealed }) {
  const canvasRef = useRef(null);
  const discRef = useRef(null);

  useEffect(() => {
    const viz = new Visualizer(canvasRef.current, discRef.current);
    viz.start();
    attach(viz);
    return () => {
      attach(null);
      viz.destroy();
    };
  }, [attach]);

  const showArt = revealed && !!artwork;

  return (
    <div className="viz">
      <canvas ref={canvasRef} className="viz-canvas" aria-hidden="true" />
      <div ref={discRef} className={`viz-disc${showArt ? ' has-art' : ''}`}>
        <div className="viz-grooves" aria-hidden="true" />
        <div className="viz-clock">
          <span className={`viz-timer${urgent ? ' urgent' : ''}${glyph ? ' glyph' : ''}`}>{timer}</span>
          {caption && <span className="viz-caption">{caption}</span>}
        </div>
        <ArtLabel src={showArt ? artwork : null} />
      </div>
    </div>
  );
}

/* The artwork fades out over half a second; keep the last image on the label
   until that has finished rather than letting it blink to a broken glyph. */
function ArtLabel({ src }) {
  const last = useRef(null);
  if (src) last.current = src;
  return (
    <div className={`viz-label${src ? ' on' : ''}`} aria-hidden={!src}>
      {last.current && <img src={last.current} alt="" />}
      <span className="viz-spindle" />
    </div>
  );
}
