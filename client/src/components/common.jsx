import { initial } from '../lib/format.js';
import { LogoBars } from './glyphs.jsx';

/** The meter bars, then Memory in cream and Beat in lemon -- the one place
 *  that yellow is used. `bars` is how many; the home page's are live. */
export function Wordmark({ href = '/', className = '', bars = 3 }) {
  const text = (
    <>
      {bars > 0 && <LogoBars count={bars} />}
      <span>Memory<span className="wordmark-beat">Beat</span></span>
    </>
  );
  if (!href) return <span className={`wordmark ${className}`}>{text}</span>;
  return <a className={`wordmark ${className}`} href={href}>{text}</a>;
}

/** A player's dot: their colour, their initial when there is room for one. */
export function Avatar({ name, color, size = 30, ring = false, label = true, className = '' }) {
  return (
    <span
      className={`avatar${ring ? ' ring' : ''} ${className}`}
      style={{ '--hue': color, '--size': `${size}px` }}
      aria-hidden="true"
    >
      {label ? initial(name) : null}
    </span>
  );
}

/** The Discord avatar the server sends, or a plain dot where there is none. */
export function DiscordAvatar({ src, size = 32 }) {
  if (!src) return <span className="avatar discord" style={{ '--size': `${size}px` }} aria-hidden="true" />;
  return <img className="avatar-img" src={src} alt="" width={size} height={size} loading="lazy" />;
}
