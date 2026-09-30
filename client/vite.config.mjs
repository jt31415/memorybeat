import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * The client is a single page app served by the game server in production
 * (see server/index.js). In development Vite serves it on its own port and
 * hands everything the page talks to -- the API, the audio proxy, sign-in and
 * the socket -- through to the game server on :3000, so one `npm start` and one
 * `npm run dev` are the whole setup.
 */
const SERVER = process.env.MEMORYBEAT_SERVER || 'http://localhost:3000';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/auth': SERVER,
      '/a/': SERVER,
      '/socket.io': { target: SERVER, ws: true }
    }
  }
});
