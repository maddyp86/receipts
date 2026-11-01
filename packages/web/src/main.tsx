import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { PolicyPage, policyForPath } from './components/policy/PolicyPages.js';
import { MethodologyPage, isMethodologyPath } from './components/methodology/MethodologyPage.js';
// Order matters: utilities first, then the hand-written rules that must win.
// Landing page fonts, self-hosted (see tailwind.config.js). Only fetched by a
// page that uses them.
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './tailwind.css';
import './styles.css';

// Static pages share the bundle (the policies and /methodology); everything
// else is the app.
const policy = policyForPath(window.location.pathname);
const methodology = isMethodologyPath(window.location.pathname);
if (methodology) document.title = 'How Receipts works: methodology';
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      {methodology ? <MethodologyPage /> : policy ? <PolicyPage kind={policy} /> : <App />}
    </StrictMode>,
  );
}
