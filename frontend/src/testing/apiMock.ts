import { vi } from 'vitest';
import { api } from '../lib/api';

export type ApiOptions = NonNullable<Parameters<typeof api>[1]>;
/**
 * A test's stand-in for the server. One route table answers every path, so it
 * returns `Promise<unknown>`; the responses it gives are typed where they are
 * built (see ./fixtures and `satisfies` on the response contracts).
 */
export type ApiRoutes = (path: string, options?: ApiOptions) => Promise<unknown>;

// api() is generic (`api<T>(): Promise<T>`) and no route table can return every
// T, so this is the one place a route table is cast to api's signature.
const asApi = (routes: ApiRoutes) => routes as typeof api;

/** Answers every api() call with `routes`. The test file must `vi.mock('../lib/api')` with `api: vi.fn()`. */
export function mockApi(routes: ApiRoutes) {
  vi.mocked(api).mockImplementation(asApi(routes));
}

/** Answers only the next api() call with `routes`. */
export function mockApiOnce(routes: ApiRoutes) {
  vi.mocked(api).mockImplementationOnce(asApi(routes));
}
