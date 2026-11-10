import { afterEach } from 'vitest';
import { clearApiCacheForTests } from './lib/apiCache';

// The GET cache is module state; each test starts as a fresh browser session.
afterEach(() => clearApiCacheForTests());
