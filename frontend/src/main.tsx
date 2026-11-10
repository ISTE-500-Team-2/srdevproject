import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/black-ops-one/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { startAppearanceSync } from './theme/appearance';
import './styles.css';
import './tables.css';
// Last, so designed dark rules win over generated twins.
import './theme/dark.css';

// System mode and other tabs are tracked on every page, not only where a theme control is mounted.
startAppearanceSync();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
