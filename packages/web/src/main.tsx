import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { PolicyPage, policyForPath } from './components/policy/PolicyPages.js';
// Order matters: utilities first, then the hand-written rules that must win.
import './tailwind.css';
import './styles.css';

// Three static pages share the bundle; everything else is the app.
const policy = policyForPath(window.location.pathname);
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      {policy ? <PolicyPage kind={policy} /> : <App />}
    </StrictMode>,
  );
}
