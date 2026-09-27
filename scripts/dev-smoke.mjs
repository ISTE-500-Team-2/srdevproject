// CI smoke: real Docker DB + API + Vite, with real email always disabled.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const child=spawn(process.execPath,[process.env.npm_execpath,'run','dev'],{stdio:'inherit',detached:process.platform!=='win32'});
let exited=false;child.on('exit',()=>{exited=true;});
try {
 let ready=false;
 for(let i=0;i<180;i++) {
  if(exited)throw new Error('Launcher exited before startup');
  try {
   const response=await fetch('http://localhost:5173/api/config',{signal:AbortSignal.timeout(1000)});
   if(response.ok){assert.equal((await response.json()).data.demoLogin,true);ready=true;break;}
  } catch {}
  await delay(1000);
 }
 assert.ok(ready,'Vite proxy did not become ready');
 const response=await fetch('http://localhost:5173/api/auth/demo',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:5173'},body:JSON.stringify({role:'member'})});
 assert.equal(response.status,200,await response.text());
 assert.equal((await fetch('http://localhost:8080/api/health')).status,200);
 console.log('Launcher smoke passed: Docker, migration, Vite proxy, and demo login. No real emails.');
} finally {
 if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
 else try {process.kill(-child.pid,'SIGTERM');} catch {}
}
