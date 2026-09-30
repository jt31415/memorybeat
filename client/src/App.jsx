import Home from './pages/Home.jsx';
import Daily from './pages/Daily.jsx';
import Room from './pages/Room.jsx';

/*
 * Three pages, picked by path. Moving between them is an ordinary page load
 * rather than client-side routing, and that is deliberate: a room owns a socket
 * and an audio graph for as long as it is open, and a full navigation is the
 * one way of leaving it that can never leave either of them running.
 */
function route(pathname) {
  const room = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (room) return { page: 'room', code: decodeURIComponent(room[1]).toUpperCase() };
  if (/^\/daily\/?$/.test(pathname)) return { page: 'daily' };
  return { page: 'home' };
}

export default function App() {
  const { page, code } = route(window.location.pathname);
  if (page === 'room') return <Room code={code} />;
  if (page === 'daily') return <Daily />;
  return <Home />;
}
