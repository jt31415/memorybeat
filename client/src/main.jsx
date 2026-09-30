import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { migrateStorage } from './lib/storage.js';
import App from './App.jsx';
import './styles.css';

migrateStorage();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
