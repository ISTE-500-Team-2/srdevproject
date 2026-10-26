// Cutover review candidate; NOT automatically installed by the app deployer.
// Every application request, including NFC, goes to the SAME public backend.
import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export function createEdge({digest,allowedPeers,stateFile,applicationPort=8082}) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid credential digest');
  const expected=Buffer.from(digest,'hex');
  const peers=new Set(allowedPeers);
  const server=http.createServer(async(req,res)=>{
    const send=(status,data)=>{
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(data));
    };
    if (!peers.has(req.socket.remoteAddress)) return send(403,{error:'Forbidden'});
    if (req.url !== '/api/gateway/health') {
      if (req.url?.startsWith('/api/gateway/')) return send(404,{error:'Not found'});
      const headers={...req.headers,'x-forwarded-proto':'https'};
      delete headers.forwarded;
      delete headers['x-forwarded-for'];
      // No reader-ID override, secondary upstream or failure fallback to demo.
      const upstream=http.request({hostname:'127.0.0.1',port:applicationPort,path:req.url,
        method:req.method,headers,timeout:15000},response=>{
        res.writeHead(response.statusCode || 502,response.headers);
        response.pipe(res);
      });
      upstream.on('timeout',()=>upstream.destroy());
      upstream.on('error',()=>{if(!res.headersSent)send(502,{error:'Application unavailable'});else res.destroy();});
      req.on('aborted',()=>upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (req.method !== 'GET') return send(405,{error:'Method not allowed'});
    const auth=req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !timingSafeEqual(createHash('sha256').update(auth.slice(7)).digest(),expected))
      return send(401,{error:'Unauthorized'});
    try {
      // Health must describe the same authoritative backend, not the demo.
      const upstream=await fetch(`http://127.0.0.1:${applicationPort}/api/health`,{signal:AbortSignal.timeout(4000)});
      const body=await upstream.json();
      const healthy=upstream.ok && body?.data?.status==='ok' && body?.data?.database==='connected';
      const data={gatewayId:'arbor-pi-01',status:healthy?'ok':'unavailable',
        database:healthy?'connected':'unavailable',lastSeen:new Date().toISOString(),
        readerHandlingEnabled:false,accessDecisionsEnabled:false};
      // Flags remain conservative: database health does not prove reader readiness.
      writeFileSync(stateFile+'.tmp',JSON.stringify(data)+'\n',{mode:0o600});
      renameSync(stateFile+'.tmp',stateFile);
      send(healthy?200:503,{data});
    } catch {send(503,{error:'Backend unavailable'});}
  });
  server.headersTimeout=5000;
  server.requestTimeout=7000;
  server.maxHeadersCount=30;
  return server;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const server=createEdge({
    digest:readFileSync(process.env.GATEWAY_TOKEN_HASH_FILE,'utf8').trim(),
    allowedPeers:(process.env.GATEWAY_PROXY_PEERS || '172.16.1.254,127.0.0.1').split(','),
    stateFile:process.env.GATEWAY_STATE_FILE || '/state/heartbeat.json',
  });
  server.listen(8080,process.env.GATEWAY_BIND_ADDRESS || '172.16.0.2',()=>console.log('Gateway health adapter listening'));
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>server.close(()=>process.exit(0)));
}
