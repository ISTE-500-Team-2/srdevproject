import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createEdge} from './rles-edge.mjs';

const listen = server => new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close = server => new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
test('portal, all reader IDs and health use one upstream; signed bytes survive unchanged',async()=>{
  const seen=[];
  let healthy=true;
  const app=http.createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    seen.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()});
    if(req.url==='/api/health') {
      res.writeHead(healthy?200:503,{'Content-Type':'application/json'});
      res.end(JSON.stringify({data:{status:healthy?'ok':'unavailable',database:healthy?'connected':'unavailable'}}));
    } else {res.writeHead(200,{'Content-Type':'application/json'});res.end('{"data":"public"}');}
  });
  const dir=await mkdtemp(path.join(os.tmpdir(),'arbor-edge-'));
  const stateFile=path.join(dir,'heartbeat.json');
  const appPort=await listen(app);
  const edge=createEdge({digest:createHash('sha256').update('fixture-token').digest('hex'),
    allowedPeers:['127.0.0.1'],stateFile,applicationPort:appPort});
  const base=`http://127.0.0.1:${await listen(edge)}`;
  try {
    assert.equal((await fetch(base+'/api/me')).status,200);
    for(const reader of ['arbor-pi-01-test','real-reader','unknown']) {
      const body='{ "uid": "04010203", "eventId": "fixture" }';
      const headers={'Content-Type':'application/json','X-Reader-ID':reader,
        'X-Reader-Timestamp':'1234567890123','X-Reader-Signature':'fixture-signature',
        'Forwarded':'spoofed','X-Forwarded-For':'spoofed','X-Forwarded-Proto':'http'};
      await fetch(base+'/api/devices/decision',{method:'POST',headers,body});
      const received=seen.at(-1);
      assert.equal(received.body,body);
      assert.equal(received.headers['x-reader-id'],reader);
      assert.equal(received.headers['x-reader-signature'],headers['X-Reader-Signature']);
      assert.equal(received.headers['x-reader-timestamp'],headers['X-Reader-Timestamp']);
      assert.equal(received.headers['x-forwarded-proto'],'https');
      assert.equal(received.headers.forwarded,undefined);
      assert.equal(received.headers['x-forwarded-for'],undefined);
    }
    const count=seen.length;
    assert.equal((await fetch(base+'/api/gateway/health')).status,401);
    assert.equal((await fetch(base+'/api/gateway/unknown')).status,404);
    assert.equal(seen.length,count,'gateway controls never reach application');
    const headers={Authorization:'Bearer fixture-token'};
    assert.equal((await fetch(base+'/api/gateway/health',{headers})).status,200);
    assert.equal(seen.at(-1).url,'/api/health');
    const state=JSON.parse(await readFile(stateFile,'utf8'));
    assert.equal(state.database,'connected');
    assert.equal(state.accessDecisionsEnabled,false,'health is not hardware acceptance');
    healthy=false;
    assert.equal((await fetch(base+'/api/gateway/health',{headers})).status,503);
    await close(app);
    assert.equal((await fetch(base+'/api/devices/decision',{method:'POST'})).status,502,
      'upstream failure must never fall back to demo');
  } finally {await close(edge);await close(app);await rm(dir,{recursive:true,force:true});}
});
test('untrusted network peer cannot reach application or health',async()=>{
  const edge=createEdge({digest:'a'.repeat(64),allowedPeers:[],stateFile:'unused'});
  const base=`http://127.0.0.1:${await listen(edge)}`;
  try {
    for(const url of ['/api/me','/api/devices/decision','/api/gateway/health'])
      assert.equal((await fetch(base+url)).status,403);
  } finally {await close(edge);}
});
