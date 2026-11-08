import { Router, type RequestHandler } from 'express';

type RouterLayer = {
  route?: { path: unknown };
  handle?: { stack?: RouterLayer[] };
  slash?: boolean;
};

/**
 * Lists every route path registered on a router, including routers mounted at
 * its root. Path-mounted `use()` layers are gates (they call next or throw), so
 * they add no paths; a router mounted under a path would hide its routes, so
 * that is refused instead of guessed at.
 */
export function routePaths(router: { stack: readonly unknown[] }): unknown[] {
  return (router.stack as RouterLayer[]).flatMap((layer) => {
    if (layer.route) return [layer.route.path];
    if (!Array.isArray(layer.handle?.stack)) return [];
    if (!layer.slash)
      throw new Error('Mount API routers at the root so unknown paths can be told apart.');
    return routePaths(layer.handle as { stack: RouterLayer[] });
  });
}

/**
 * Sends paths that no route serves to `notFound` before authentication runs, so
 * a mistyped endpoint is a 404 rather than a 401. Matching uses Express itself.
 */
export function knownRoutesOnly(router: { stack: readonly unknown[] }, notFound: RequestHandler) {
  const known = Router();
  for (const path of routePaths(router))
    known.all(path as string | string[], (_req, _res, next) => next('router'));
  known.use(notFound);
  return known;
}
