import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const emailNames = ['BREVO_API_KEY','EMAIL_FROM','EMAIL_REPLY_TO','EMAIL_FROM_NAME','EMAIL_POSTAL_ADDRESS','EMAIL_WORKER_INTERVAL_MS'];
export function makeEnv(parent, local, email) {
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    if (/^(PG|DATABASE_URL$|EMAIL_|BREVO_|JWT_)/i.test(key)) delete env[key];
  }
  if (email) for (const key of emailNames) if (local[key] !== undefined) env[key] = local[key];
  if (email && !env.BREVO_API_KEY?.trim()) throw new Error('Add BREVO_API_KEY to the root .env.local before running npm run dev:email.');
  Object.assign(env, {
    NODE_ENV:'development', HOST:'127.0.0.1', PORT:'8080', APP_ORIGIN:'http://localhost:5173',
    ENABLE_DEMO_LOGIN: String(!email), EMAIL_ENABLED: String(email),
    PGHOST:'127.0.0.1', PGPORT:email ? '25435' : '25434', PGUSER:'arbor_mvc',
    PGDATABASE:email ? 'arbor_email_mvc_dev' : 'arbor_mvc_dev',
    JWT_DEV_KEY_FILE:path.join(root,'.local',email ? 'email-jwt.key' : 'demo-jwt.key'),
  });
  env.DEV_DB_NAME=env.PGDATABASE; env.DEV_DB_PORT=env.PGPORT;
  return env;
}
export function frontendEnv(parent) {
  const env={...parent};
  for(const key of Object.keys(env)) if(/^(PG|DATABASE_URL$|EMAIL_|BREVO_|JWT_)/i.test(key)) delete env[key];
  env.NODE_ENV='development'; return env;
}
export async function assertFree(port) {
  await new Promise((resolve,reject) => {
    const server=createServer();
    server.once('error',()=>reject(new Error(`Port ${port} is already in use. Stop the old local process before starting this launcher.`)));
    server.listen(port,'127.0.0.1',()=>server.close(resolve));
  });
}
async function main() {
  const args=process.argv.slice(2);
  if(args.some(a=>a!=='--email')) throw new Error('Usage: npm run dev OR npm run dev:email');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22 || major===22 && minor<18) throw new Error('Install Node 22.18 or newer.');
  const email=args.includes('--email');
  const file=path.join(root,'.env.local');
  const local=email && existsSync(file) ? parseEnv(readFileSync(file,'utf8')) : {};
  const env=makeEnv(process.env,local,email);
  const clean=frontendEnv(process.env);
  const npmCli=process.env.npm_execpath;
  if(!npmCli || !existsSync(npmCli)) throw new Error('Start with npm run dev or npm run dev:email from the repository root.');
  const children=new Set(); let stopping=false;
  function child(command,args,options={}) {
    const p=spawn(command,args,{cwd:root,env:clean,stdio:'inherit',...options});
    children.add(p); p.once('exit',()=>children.delete(p)); return p;
  }
  function run(command,args,options) {
    return new Promise((resolve,reject)=>{
      const p=child(command,args,options);
      p.once('error',()=>reject(new Error(`Could not start ${path.basename(command)}. Check that it is installed and on PATH.`)));
      p.once('exit',code=>code===0 ? resolve() : reject(new Error(`${path.basename(command)} exited with code ${code}. See the error above.`)));
    });
  }
  function stop(code=0) {
    if(stopping)return; stopping=true;
    for(const p of children) {
      if(process.platform==='win32') spawn('taskkill',['/pid',String(p.pid),'/T','/F'],{stdio:'ignore'});
      else {try {process.kill(-p.pid,'SIGTERM');} catch {p.kill('SIGTERM');}}
    }
    process.exitCode=code;
    setTimeout(()=>process.exit(code),2500).unref();
  }
  process.once('SIGINT',()=>stop()); process.once('SIGTERM',()=>stop());
  try {
    await assertFree(8080); await assertFree(5173);
    await run('docker',['info','--format','{{.ServerVersion}}']);
    mkdirSync(path.join(root,'.local'),{recursive:true});
    for(const dir of ['backend','frontend']) {
      const hash=createHash('sha256').update(readFileSync(path.join(root,dir,'package-lock.json'))).update(process.versions.node).digest('hex');
      const stamp=path.join(root,'.local',`${dir}-dependencies`);
      if(!existsSync(path.join(root,dir,'node_modules')) || !existsSync(stamp) || readFileSync(stamp,'utf8')!==hash) {
        await run(process.execPath,[npmCli,'ci','--prefix',dir]); writeFileSync(stamp,hash);
      }
    }
    await run('docker',['compose','-p',email?'arbor-team-email':'arbor-team-demo','-f','compose.dev.yml','up','-d','--wait','db'],{env:{...clean,DEV_DB_NAME:env.DEV_DB_NAME,DEV_DB_PORT:env.DEV_DB_PORT}});
    await run(process.execPath,[npmCli,'run','setup:demo','--prefix','backend'],{env});
    console.log(`\nMode: ${email?'REAL EMAIL — demo buttons off':'DEMO — real emails OFF; use Member/Admin demo'}`);
    console.log(`Local database: ${env.PGDATABASE} at 127.0.0.1:${env.PGPORT}`);
    console.log('API: http://localhost:8080 | Frontend: http://localhost:5173');
    console.log('Ctrl+C stops the API and Vite. Database and saved data remain.');
    const launch=(args,options)=>{
      const p=child(process.execPath,args,{detached:process.platform!=='win32',...options});
      p.once('error',()=>stop(1)); p.once('exit',code=>{if(!stopping){console.error('A development process stopped; shutting down the other process.');stop(code || 1);}});
    };
    launch([path.join(root,'backend/node_modules/tsx/dist/cli.mjs'),'watch','src/server.ts'],{cwd:path.join(root,'backend'),env});
    launch([path.join(root,'frontend/node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5173','--strictPort'],{cwd:path.join(root,'frontend'),env:clean});
  } catch(error) { stop(1); throw error; }
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(`Setup stopped: ${error.message}`);process.exitCode=1;});
}
