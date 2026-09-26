import fs from 'node:fs/promises';
const str={type:'string'},bool={type:'boolean'},integer={type:'integer',minimum:0},id={type:'string',format:'uuid'},date={type:'string',format:'date-time'},nullable=s=>({anyOf:[s,{type:'null'}]}),array=items=>({type:'array',items}),ref=name=>({$ref:`#/components/schemas/${name}`});
const object=(properties,required=Object.keys(properties),additionalProperties=true)=>({type:'object',properties,required,additionalProperties});
const hash={type:'string',pattern:'^[a-f0-9]{64}$'},graph=object({nodes:array({type:'object'}),edges:array({type:'object'})}),config={type:'object',description:'Canonical Vector configuration; unknown properties are preserved. Secrets and unsafe capabilities are validated independently.'};
const metric=nullable({type:'number',minimum:0,maximum:1e15});
const componentMetric=object({id:{type:'string',maxLength:100},type:{type:'string',maxLength:100},events_per_second:metric,errors:metric,discarded_events:metric,buffer_bytes:metric},['id'],false);
const schemas={
 Error:object({error:object({code:str,message:str})}),
 User:object({id,email:{type:'string',format:'email'},name:str,role:{enum:['viewer','editor','operator','admin']}}),
 Session:object({user:ref('User'),csrf_token:str}),
 Status:object({initialized:bool,version:str}),
 Configuration:object({id,name:str,description:str,revision:integer,graph,config,created_at:date,updated_at:date}),
 Version:object({id,configuration_id:id,number:integer,graph,config,artifact:str,sha256:hash,size:integer,created_at:date,message:str,uses_local_secrets:bool,validation:{type:'object'}},['id','configuration_id','number','graph','config','artifact','sha256','size','created_at','message','validation']),
 AgentPolicy:object({heartbeat_seconds:{type:'integer',minimum:10,maximum:3600},sync_paused:bool,telemetry_enabled:bool}),
 Selector:object({device_ids:array(id),group_ids:array(id),exclude_ids:array(id)}),
 Rollout:object({kind:{enum:['all','canary']},canary_size:{type:'integer',minimum:1},batch_size:{type:'integer',minimum:1},observation_seconds:{type:'integer',minimum:0},failure_threshold:integer}),
 Telemetry:object({sampled_at:date,events_per_second:metric,errors:metric,uptime_seconds:metric,memory_bytes:metric,cpu_seconds:metric,discarded_events:metric,buffer_bytes:metric,components:{type:'array',maxItems:50,items:componentMetric}},['sampled_at']),
 TelemetryHistory:object({device_id:id,samples:array(ref('Telemetry'))}),
 Device:object({id,name:str,os:str,arch:str,agent_version:str,vector_version:str,status:str,apply_state:str,desired_generation:integer,reported_generation:integer,last_seen:nullable(date),desired_version_id:nullable(id),actual_sha256:nullable(hash),applied_template_sha256:nullable(hash),secret_revision:integer,uses_local_secrets:bool,local_paused:bool,labels:{type:'object'},sync_paused:bool,pause_acknowledged:bool,telemetry:nullable(ref('Telemetry')),created_at:date},['id','name','status','apply_state','desired_generation','reported_generation']),
 DeploymentTarget:object({device_id:id,state:str,generation:integer,error:nullable(str)},['device_id','state','generation']),
 Deployment:object({id,version_id:nullable(id),policy:nullable(ref('AgentPolicy')),selector:ref('Selector'),priority:{type:'integer'},target_mode:{enum:['snapshot','persistent']},status:{enum:['scheduled','active','paused','completed','cancelled','failed','missed','unassigned']},scheduled_at:nullable(date),created_at:date,targets:array(ref('DeploymentTarget')),rollout:ref('Rollout')},['id','selector','priority','target_mode','status','created_at','targets','rollout']),
 DeploymentRequest:object({version_id:id,policy:ref('AgentPolicy'),selector:ref('Selector'),expected_device_ids:array(id),priority:{type:'integer'},target_mode:{enum:['snapshot','persistent']},scheduled_at:nullable(date),rollout:ref('Rollout')},['selector','priority','target_mode','rollout']),
 Preview:object({devices:array(ref('Device')),conflicts:array({}),warnings:array(str)}),
 Group:object({id,name:str,description:str,device_ids:array(id)}),
 Token:object({id,name:str,expires_at:date,uses:integer,max_uses:nullable(integer),name_prefix:nullable(str),revoked:bool,created_at:date}),
 TokenCreated:object({token:str,record:ref('Token')}),
 Release:object({name:str,os:str,arch:str,version:str,sha256:hash,size:integer,url:str,signed:bool}),
 Validation:object({valid:bool,errors:array(str),warnings:array(str)}),
 EnrollmentRequest:object({protocol_version:{const:1},request_id:{type:'string',minLength:1,maxLength:128},token:{type:'string',minLength:1,maxLength:512},name:{type:'string',minLength:1,maxLength:100},csr_pem:{type:'string',minLength:1,maxLength:16384},os:str,arch:str,agent_version:str,vector_version:str}),
 Credential:object({device_id:id,certificate_pem:str,ca_pem:str,signing_public_key:{type:'string',contentEncoding:'base64'},certificate_expires_at:date}),
 HeartbeatRequest:object({protocol_version:{const:1},request_id:str,nonce:{type:'string',contentEncoding:'base64',description:'Exactly 32 unpredictable decoded bytes'},boot_id:str,agent_version:str,vector_version:str,reported_generation:integer,policy_generation:integer,actual_sha256:nullable(str),applied_template_sha256:nullable(hash),secret_revision:integer,apply_state:{enum:['unmanaged','desired','downloaded','validated','written','reload_requested','verified_applied','verification_unknown','failed','rolled_back','paused']},local_paused:bool,remote_pause_acknowledged:bool,telemetry:nullable(ref('Telemetry')),error:nullable(object({code:str,stage:str,message:str}))},['protocol_version','request_id','nonce','boot_id','agent_version','vector_version','reported_generation','policy_generation','actual_sha256','apply_state','local_paused','remote_pause_acknowledged']),
 DesiredArtifact:object({version_id:id,sha256:hash,size:{type:'integer',minimum:1,maximum:1048576},artifact_path:{type:'string',pattern:'^/agent/v1/artifacts/[a-f0-9]{64}$'},vector_version:str}),
 Manifest:object({protocol_version:{const:1},device_id:id,nonce:str,issued_at:date,expires_at:date,generation:integer,policy_generation:integer,policy:ref('AgentPolicy'),desired:nullable(ref('DesiredArtifact'))}),
 SignedManifest:object({payload:{type:'string',contentEncoding:'base64',description:'Exact UTF-8 JSON Manifest bytes, decoded before signature verification'},signature:{type:'string',contentEncoding:'base64',description:'Ed25519 signature over exact decoded payload'}}),
};
const paths={};
const response=schema=>({'200':{description:'Success',content:{'application/json':{schema}}},'400':{description:'Invalid input',content:{'application/json':{schema:ref('Error')}}},'401':{description:'Authentication required',content:{'application/json':{schema:ref('Error')}}},'403':{description:'Forbidden',content:{'application/json':{schema:ref('Error')}}},'409':{description:'Conflict or stale revision',content:{'application/json':{schema:ref('Error')}}},'429':{description:'Rate limit'}});
function route(path,method,summary,out={},body,publicRoute=false,device=false){paths[path]??={};paths[path][method]={summary,operationId:method+'_'+path.replace(/[^a-z0-9]/gi,'_'),security:publicRoute?[]:device?[{deviceMTLS:[]}]:[{sessionCookie:[]}],parameters:[...Array.from(path.matchAll(/\{(\w+)\}/g),m=>({name:m[1],in:'path',required:true,schema:str})),...(!device&&!publicRoute&&method!=='get'?[{name:'X-CSRF-Token',in:'header',required:true,schema:str}]:[])],...(body?{requestBody:{required:true,content:{'application/json':{schema:body}}}}:{}),responses:response(out)};}
route('/api/v1/status','get','Public initialization status',ref('Status'),null,true);
route('/api/v1/bootstrap','post','Transactionally initialize the first administrator',ref('Session'),object({bootstrap_secret:str,email:str,name:str,password:{type:'string',minLength:12}}),true);
route('/api/v1/login','post','Create rotated browser session',ref('Session'),object({email:str,password:str,totp_code:str,recovery_code:str},['email','password']),true);
route('/api/v1/session','get','Current session and CSRF token',ref('Session'));
route('/api/v1/logout','post','Revoke current session');
for(const [plural,schema] of [['devices','Device'],['configurations','Configuration'],['deployments','Deployment'],['groups','Group'],['tokens','Token'],['releases','Release'],['users','User']])route(`/api/v1/${plural}`,'get',`List ${plural}`,array(ref(schema)));
for(const [plural,schema] of [['devices','Device'],['configurations','Configuration'],['deployments','Deployment'],['versions','Version']])route(`/api/v1/${plural}/{id}`,'get',`Read ${schema}`,ref(schema));
for(const collection of ['overview','issues','audit','policies','settings'])route(`/api/v1/${collection}`,'get',`Read ${collection}`);
route('/api/v1/configurations','post','Create canonical configuration and first immutable draft revision',ref('Configuration'),object({name:str,description:str,config,graph}));
route('/api/v1/configurations/{id}/draft','put','Save draft with optimistic concurrency',ref('Configuration'),object({revision:integer,config,graph,message:str}));
route('/api/v1/configurations/{id}/revisions','get','Read immutable draft revisions',array({type:'object'}));
route('/api/v1/configurations/{id}/versions','get','Read immutable published versions',array(ref('Version')));
route('/api/v1/configurations/{id}/validate','post','Validate structure and configured isolated worker',ref('Validation'),object({config}));
route('/api/v1/configurations/{id}/publish','post','Publish immutable artifact without deploying',ref('Version'),object({revision:integer,message:str}));
route('/api/v1/deployments/preview','post','Preview effective targets and transactional priority conflicts',ref('Preview'),ref('DeploymentRequest'));
route('/api/v1/deployments','post','Create immediate or scheduled deployment',ref('Deployment'),ref('DeploymentRequest'));
for(const action of ['pause','resume','cancel','rollback','unassign'])route(`/api/v1/deployments/{id}/${action}`,'post',`${action} deployment`,ref('Deployment'));
for(const action of ['refresh-preview','unassign-preview'])route(`/api/v1/deployments/{id}/${action}`,'post',`Preview ${action}`,ref('Preview'));
route('/api/v1/deployments/{id}/refresh','post','Refresh scheduled snapshot after review',ref('Deployment'),object({expected_device_ids:array(id)}));
const groupBody=object({name:str,description:str,device_ids:array(id)});route('/api/v1/groups','post','Create operator-controlled group',ref('Group'),groupBody);route('/api/v1/groups/{id}','put','Update membership and re-resolve transactionally',ref('Group'),groupBody);
route('/api/v1/policies','post','Create complete agent policy',{},object({name:str,policy:ref('AgentPolicy')}));
route('/api/v1/tokens','post','Create scoped reusable enrollment token; display secret once',ref('TokenCreated'),object({name:str,expires_hours:{type:'integer',minimum:1,maximum:720},max_uses:nullable(integer),name_prefix:nullable(str)},['name','expires_hours']));
route('/api/v1/tokens/{id}/revoke','post','Revoke future enrollment permission');
route('/api/v1/devices/{id}/revoke','post','Revoke registered device identity on every future operation');
route('/api/v1/devices/{id}/recover','post','Admin-issued one-time exact-name new-UUID recovery token',ref('TokenCreated'));
route('/api/v1/devices/{id}/telemetry','get','Last 120 chronological persisted telemetry buckets',ref('TelemetryHistory'));
route('/api/v1/devices/{id}/retry','post','Bounded new generation retry',ref('Device'));
route('/api/v1/users','post','Admin creates local user',ref('User'),object({name:str,email:str,password:{type:'string',minLength:12},role:schemas.User.properties.role}));
route('/api/v1/mfa','get','MFA status',object({enabled:bool}));route('/api/v1/mfa/setup','post','Password-gated MFA setup',object({secret:str,otpauth_url:str}),object({password:str}));route('/api/v1/mfa/confirm','post','Enable MFA; display one-use recovery codes once',object({enabled:bool,recovery_codes:array(str)}),object({code:str}));route('/api/v1/mfa/disable','post','Disable MFA and revoke other sessions',{},object({password:str,code:str,recovery_code:str},['password']));
route('/api/v1/vrl/test','post','Execute synthetic VRL in the isolated bounded validator',object({valid:bool,output:{},errors:array(str)}),object({program:{type:'string',maxLength:16384},sample:{type:'object'}}));
route('/api/v1/openapi.json','get','Read the authenticated OpenAPI contract');
route('/agent/v1/enroll','post','Verified TLS enrollment with CSR possession proof',ref('Credential'),ref('EnrollmentRequest'),true,true);
route('/agent/v1/heartbeat','post','Active registered mTLS device heartbeat; signed nonce-bound desired state',ref('SignedManifest'),ref('HeartbeatRequest'),false,true);
route('/agent/v1/renew','post','Renew or rotate key with current active authentication',ref('Credential'),object({csr_pem:str}),false,true);
route('/agent/v1/artifacts/{sha256}','get','Fetch only current released device artifact',{type:'string'},null,false,true);
paths['/agent/v1/artifacts/{sha256}'].get.responses['200'].content={'application/json':{schema:{type:'string',description:'Exact UTF-8 Vector JSON artifact bytes, not a JSON string wrapper'}}};
const spec={openapi:'3.1.0',info:{title:'Vectory control plane',version:'0.1.0',description:'Single-instance self-hosted Vector configuration control plane. Agent paths use the separately configured TLS listener. Session mutations require CSRF. No request-body device UUID is trusted for authentication.'},servers:[{url:'/',description:'Same-origin dashboard API; agent endpoints served separately on verified TLS :8443'}],paths,components:{securitySchemes:{sessionCookie:{type:'apiKey',in:'cookie',name:'vectory_session'},deviceMTLS:{type:'mutualTLS'}},schemas}};
await fs.writeFile(new URL('./openapi.json',import.meta.url),JSON.stringify(spec,null,2)+'\n');
const replaceRefs=value=>JSON.parse(JSON.stringify(value).replaceAll('#/components/schemas/','#/$defs/'));
await fs.writeFile(new URL('./protocol.schema.json',import.meta.url),JSON.stringify({$schema:'https://json-schema.org/draft/2020-12/schema',$id:'https://vectory.local/schemas/protocol-v1',title:'Vectory protocol v1',description:'Validate one named schema via $defs. Cryptographic, authorization and semantic checks remain mandatory.',$defs:replaceRefs(schemas)},null,2)+'\n');
console.log(`Generated ${Object.keys(paths).length} OpenAPI paths and ${Object.keys(schemas).length} shared schemas.`);
