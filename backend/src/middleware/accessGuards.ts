// Every protected route names what it requires where it is registered, with a guard tagged here.
// The route audit test reads these tags, so a route left to a path prefix (or to nothing) fails it.

import type { NextFunction, Request, Response } from 'express';

type Guard = (req: Request, res: Response, next: NextFunction) => unknown;

const requirements = new WeakMap<Guard, string>();

/** Tags `guard` as a route's access requirement, described by `requirement`, and returns it. */
export function accessGuard<T extends Guard>(requirement: string, guard: T): T {
  requirements.set(guard, requirement);
  return guard;
}

/** The requirement a route handler declares, or undefined when it is not an access guard. */
export function accessRequirement(handler: unknown): string | undefined {
  return typeof handler === 'function' ? requirements.get(handler as Guard) : undefined;
}
