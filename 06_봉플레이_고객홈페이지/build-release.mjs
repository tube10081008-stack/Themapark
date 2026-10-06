// Run from this project: node build-release.mjs <new-empty-output-directory> <source-commit>
// Default: basic guidance. Pass runtime-enabled only for an authorized model release.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const output=path.resolve(process.argv[2]||'');const commit=process.argv[3];
const mode=process.argv[4]||'basic-guidance';
if(!['basic-guidance','runtime-enabled'].includes(mode))throw Error('Unknown release mode');
if(!process.argv[2]||!/^\w{40}$/.test(commit||''))throw Error('Output directory and full source commit required');
if(fs.existsSync(output))throw Error('Use a new output directory; existing output is never overwritten');
const publicFiles=['index.html','404.html','styles.css','app.js','config.js','consultation.js','consultation.css',
  'assets/favicon.svg','assets/fonts/BongplaySans.woff2','assets/fonts/OFL.txt',
  'assets/images/bongplay-logo.webp','assets/images/indoor-wide.webp','assets/images/net-adventure.webp',
  'assets/images/site-001.jpg','assets/images/site-002.jpg','assets/images/site-004.jpg','assets/images/zip-adventure.webp'];
// Derive asset paths from the actual tree, then check against the explicit basename allowlist.
const allowedAssetNames=new Set(publicFiles.filter(p=>p.startsWith('assets/')).map(p=>path.basename(p)));
const assets=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Links are not supported');if(e.isDirectory())walk(p);else if(allowedAssetNames.has(e.name))assets.push(path.relative(root,p).replaceAll('\\','/'));else throw Error('Unreviewed asset: '+e.name);}}
walk(path.join(root,'assets'));
const files=[...publicFiles.filter(p=>!p.startsWith('assets/')).map(p=>[p,'public/'+p]),...assets.map(p=>[p,'public/'+p]),
  ...['consult.mjs','lib/consultation.mjs','lib/knowledge.mjs','lib/decision-engine.mjs','lib/model-provider.mjs','lib/rate-limit.mjs'].map(p=>['netlify/functions/'+p,'netlify/functions/'+p])];
const prepared=files.map(([src,dest])=>{let bytes=fs.readFileSync(path.join(root,src));if(src.endsWith('/consult.mjs')){
  let code=bytes.toString('utf8');const marker='const env = context.env || process.env || {};';if(!code.includes(marker))throw Error('Handler changed; review release switch');
  const replacement=mode==='basic-guidance'
    ? "const env = {...(context.env || process.env || {}), CONSULT_PROVIDER:'sakana', CONSULT_ENABLED:'false', JEV_ENABLED:'false'};"
    : "const env = {CONSULT_PROVIDER:'sakana', CONSULT_MODEL:'fugu', CONSULT_ENABLED:'true', ...(context.env || process.env || {}), JEV_ENABLED:'false'};";
  code=code.replace(marker,replacement);bytes=Buffer.from(code);
}if(bytes.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')))throw Error('Private key in release');return [dest,bytes];});
const config=fs.readFileSync(path.join(root,'netlify.toml'),'utf8').replace('publish = "."','publish = "public"');
prepared.push(['netlify.toml',Buffer.from(config)]);
const manifest={schema:1,sourceCommit:commit,mode,externalModelCalls:mode==='runtime-enabled'?'requires server key and shared rate-limit store':false,transform:mode==='basic-guidance'?'force both provider switches off in function handler':'default sakana/fugu enabled; server env overrides; legacy JEV off; shared-store guard unchanged',files:Object.fromEntries(prepared.map(([p,b])=>[p,crypto.createHash('sha256').update(b).digest('hex')]))};
prepared.push(['public/deploy-manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n')]);
for(const [p,b]of prepared){fs.mkdirSync(path.dirname(path.join(output,p)),{recursive:true});fs.writeFileSync(path.join(output,p),b);}
console.log(JSON.stringify({output,files:prepared.length,sourceCommit:commit,mode:manifest.mode}));
