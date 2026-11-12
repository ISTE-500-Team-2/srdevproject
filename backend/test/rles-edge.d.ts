// Types for the plain-JS edge gateway in deploy/rles-edge.mjs, which
// test/integration/unified-environment.test.ts imports by relative path.
// Ambient module names cannot be relative, so this matches the import by pattern.
declare module '*/deploy/rles-edge.mjs' {
  import type { Server } from 'node:http';

  export const PUBLIC_PORTS: number[];
  export function readProductionRoute(file: string): {
    version: 1;
    release: string;
    publicPort: number;
    previousPublicPort?: number | null;
  };
  export function createEdge(options: {
    digest: string;
    allowedPeers: string[];
    stateFile: string;
    applicationPort?: number;
    routeFile?: string;
  }): Server;
}
