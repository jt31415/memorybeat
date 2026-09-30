/*
 * The insets the phone round screen pins its bars to.
 *
 * An on-screen keyboard is not a layout change on iOS: it shrinks the *visual*
 * viewport and leaves the page at its full height underneath, so `bottom: 0` is
 * somewhere behind the keyboard. These two properties are the gap on each side,
 * and the pinned bars offset themselves by them. Where the browser really does
 * resize the page (Chrome, via interactive-widget=resizes-content) both come out
 * 0 and the offsets cost nothing.
 */
export function trackViewportInsets() {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const sync = () => {
    const s = document.documentElement.style;
    const top = Math.max(0, Math.round(vv.offsetTop));
    s.setProperty('--vv-top', `${top}px`);
    s.setProperty('--vv-bottom', `${Math.max(0, Math.round(window.innerHeight - vv.height - top))}px`);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
  };
}

/* Everything a phone does differently hangs off this one query. */
export const NARROW_QUERY = '(max-width: 860px)';
