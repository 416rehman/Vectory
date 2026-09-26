import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const local=path.join(root,'.local/preview');
const base='http://127.0.0.1:8080/api/v1';
const status=await fetch(`${base}/status`).then(r=>r.json());
const credentialsPath=path.join(local,'credentials.json');
let credentials;
try{credentials=JSON.parse(await fs.readFile(credentialsPath,'utf8'));}catch{credentials={name:'Local operator',email:'operator@vectory.local',password:crypto.randomBytes(24).toString('base64url')};await fs.writeFile(credentialsPath,JSON.stringify(credentials,null,2),{mode:0o600});}
if(!status.initialized){
 const bootstrap_secret=(await fs.readFile(path.join(local,'bootstrap.secret'),'utf8')).trim();
 const result=await fetch(`${base}/bootstrap`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,bootstrap_secret})});
 if(!result.ok)throw Error(`Bootstrap failed: HTTP ${result.status}`);
 console.log('Initialized the isolated local verification workspace. Credentials remain in .local/preview/credentials.json.');
}else console.log('Existing isolated verification workspace preserved.');
