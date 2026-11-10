import { afterEach } from 'vitest';
import { clearStoredSettingsForTests } from './lib/apiCache';

// Stored settings are module state; each test starts as a fresh browser session.
afterEach(() => clearStoredSettingsForTests());
