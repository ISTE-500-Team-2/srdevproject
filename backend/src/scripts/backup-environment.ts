import { Client } from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Resolve with the application's own pg parser, not a second URI parser.
// Output goes only to a mode-0600 temporary env file, never command arguments.
export function backupEnvironment(): string {
  if (!process.env.DATABASE_URL) return "";
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const p = (client as unknown as { connectionParameters: {
    host: string; port: number; user: string; password: string | null;
    database: string; options?: string;
    ssl: boolean | { rejectUnauthorized?: boolean; ca?: unknown; cert?: unknown; key?: unknown; checkServerIdentity?: unknown };
  } }).connectionParameters;
  if (typeof p.ssl === "object" && (p.ssl.ca || p.ssl.cert || p.ssl.key || p.ssl.checkServerIdentity))
    throw Error("Backup certificate configuration requires explicitly provisioned libpq certificate paths.");
  const values: Record<string, string | number | null | undefined> = {
    PGHOST: p.host, PGPORT: p.port, PGUSER: p.user, PGPASSWORD: p.password ?? "",
    PGDATABASE: p.database, PGOPTIONS: p.options ?? "",
    PGSSLMODE: !p.ssl ? "disable" : typeof p.ssl === "object" && p.ssl.rejectUnauthorized === false ? "require" : "verify-full",
  };
  return Object.entries(values).map(([key, value]) => {
    const text = String(value ?? "");
    if (/[\r\n\0]/.test(text)) throw Error("Backup connection values cannot contain line breaks or NUL bytes.");
    return `${key}=${text}\n`;
  }).join("");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(backupEnvironment()); }
  catch { console.error("Unable to prepare backup connection configuration; check the protected application environment."); process.exitCode = 1; }
}
