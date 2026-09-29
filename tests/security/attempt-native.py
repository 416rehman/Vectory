"""Actual disposable Rust server + Go agent + pinned Vector attempt accounting.

Uses fresh TLS, enrollment, signed manifests and actual Vector validation. Never
reads preview state, starts services, or changes the managed host installation.
Python cryptography/psutil are the same optional tools used by native load tests.
"""
from __future__ import annotations
import argparse, base64, hashlib, http.cookiejar, ipaddress, json, os
from pathlib import Path
import shutil, socket, ssl, subprocess, sys, tempfile, time, urllib.request, urllib.error, uuid
from datetime import datetime, timedelta, timezone
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.local/load-deps'))
import psutil
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def utc(): return datetime.now(timezone.utc).isoformat()
def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
def pki(directory):
    key=ec.generate_private_key(ec.SECP256R1()); now=datetime.now(timezone.utc)-timedelta(minutes=1)
    name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'isolated attempt review CA')])
    ca=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now).not_valid_after(now+timedelta(hours=2)).add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True).sign(key,hashes.SHA256()))
    leaf_key=ec.generate_private_key(ec.SECP256R1())
    leaf=(x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'isolated attempt server')])).issuer_name(name).public_key(leaf_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now).not_valid_after(now+timedelta(hours=2)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),critical=False).sign(key,hashes.SHA256()))
    for name,data in [('ca.pem',ca.public_bytes(serialization.Encoding.PEM)),('server.pem',leaf.public_bytes(serialization.Encoding.PEM)),('server-key.pem',leaf_key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))]:
        (directory/name).write_bytes(data); (directory/name).chmod(0o600)


def stop(process):
    if process is None or process.poll() is not None: return
    # Only descendants of this exact spawned fixture process are eligible.
    children=[]
    try: children=[(p.pid,p.create_time()) for p in psutil.Process(process.pid).children(recursive=True)]
    except psutil.Error: pass
    process.terminate()
    try: process.wait(timeout=7)
    except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
    for pid,created in children:
        try:
            p=psutil.Process(pid)
            if p.create_time()==created: p.terminate(); p.wait(timeout=5)
        except psutil.NoSuchProcess: pass
        except psutil.TimeoutExpired:
            try:
                if p.create_time()==created: p.kill(); p.wait(timeout=5)
            except psutil.NoSuchProcess: pass


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--server',type=Path,required=True)
    parser.add_argument('--agent',type=Path,required=True)
    parser.add_argument('--vector',type=Path,default=ROOT/'.local/tools/vector-0.58.0/bin/vector.exe')
    parser.add_argument('--expect',choices=['before','after','legacy'],required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args(); args.output=args.output.resolve(); args.output.mkdir(parents=True,exist_ok=True)
    report={'recorded_at':utc(),'scope':'Disposable real Rust server, Go agent process and native Vector 0.58.0. Fresh trusted TLS and real enrollment; signed desired manifest, digest-authorized artifact fetch and actual native candidate validation. Synthetic workload only. No live preview state or services accessed.','expectation':args.expect,'passed':False,'checks':[], 'binary_sha256':{k:sha(getattr(args,k)) for k in ['server','agent','vector']}}
    temp=Path(tempfile.mkdtemp(prefix='vectory-attempt-review-')).resolve(); temp.chmod(0o700)
    server=agent=None; log_handles=[]; tracked=[]
    try:
        for label in ['server','agent']:
            source=getattr(args,label).resolve(); copied=temp/(label+source.suffix); shutil.copyfile(source,copied); copied.chmod(0o700); setattr(args,label,copied)
        pki(temp); http_port,tls_port=free_port(),free_port(); origin=f'http://127.0.0.1:{http_port}'; tls_origin=f'https://127.0.0.1:{tls_port}'
        bootstrap=os.urandom(32).hex(); (temp/'bootstrap').write_text(bootstrap)
        env={k:v for k,v in os.environ.items() if not k.upper().startswith('VECTORY_') and k.upper() not in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']}
        env.update(VECTORY_DATA_DIR=str(temp/'server-state'),VECTORY_HTTP_ADDR=f'127.0.0.1:{http_port}',VECTORY_AGENT_ADDR=f'127.0.0.1:{tls_port}',VECTORY_TLS_CERT=str(temp/'server.pem'),VECTORY_TLS_KEY=str(temp/'server-key.pem'),VECTORY_BOOTSTRAP_SECRET_FILE=str(temp/'bootstrap'),VECTORY_DEVELOPMENT='true',VECTORY_COOKIE_SECURE='false',VECTORY_DASHBOARD_DIR=str(temp),VECTORY_RELEASES_DIR=str(temp/'releases'),NO_COLOR='1')
        flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
        server_log=(temp/'server.log').open('wb'); log_handles.append(server_log)
        server=subprocess.Popen([str(args.server)],env=env,cwd=temp,stdout=server_log,stderr=server_log,creationflags=flags)
        cookie=http.cookiejar.CookieJar(); client=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(cookie)); csrf=''
        def api(path,body=None,method=None):
            req=urllib.request.Request(origin+'/api/v1'+path,data=None if body is None else json.dumps(body).encode(),method=method or ('GET' if body is None else 'POST'),headers={'Content-Type':'application/json','X-CSRF-Token':csrf})
            try:
                with client.open(req,timeout=12) as response: return json.load(response)
            except urllib.error.HTTPError as e:
                data=json.load(e); raise RuntimeError(f'{req.method} {path}: HTTP {e.code} {data.get("error",{}).get("code")} {data.get("error",{}).get("message")}') from None
        def until(name,fn,timeout=100):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                if server.poll() is not None: raise RuntimeError('isolated server exited')
                result=fn()
                if result:
                    print('PASS '+name,flush=True); return result
                time.sleep(.4)
            raise RuntimeError(name+' timed out')
        def ready():
            try: return api('/status')
            except urllib.error.URLError: return None
        until('isolated server ready',ready,15)
        session=api('/bootstrap',{'bootstrap_secret':bootstrap,'name':'Synthetic attempt review','email':'attempt-review@example.invalid','password':os.urandom(24).hex()}); csrf=session['csrf_token']
        state=temp/'agent-state'; config_dir=temp/'config'; config_dir.mkdir(); managed=config_dir/'managed.json'; data_dir=temp/'vector-data'; data_dir.mkdir()
        good={'data_dir':str(data_dir),'sources':{'seed':{'type':'demo_logs','format':'json','interval':1}},'sinks':{'discard':{'type':'blackhole','inputs':['seed']}}}
        managed.write_text(json.dumps(good)); policy_path=temp/'capability-policy.json'; policy_path.write_text(json.dumps({'allowed_file_roots':[str(data_dir)]}))
        def cli(*arguments,input=None,allow_failure=False):
            result=subprocess.run([str(args.agent),*arguments],cwd=temp,input=input,text=True,capture_output=True,timeout=40,creationflags=flags)
            if result.returncode and not allow_failure: raise RuntimeError(f'Agent {arguments[0]} exited {result.returncode}: '+result.stdout[-1000:]+result.stderr[-1000:])
            return result
        cli('install','--state-dir',str(state),'--vector-binary',str(args.vector.resolve()),'--managed-config',str(managed),'--capability-policy',str(policy_path),'--adopt','--json')
        token=api('/tokens',{'name':'Synthetic native attempt fixture','expires_hours':1,'max_uses':1,'name_prefix':'attempt-'})
        cli('enroll','--state-dir',str(state),'--server',tls_origin,'--ca-file',str(temp/'ca.pem'),'--id','attempt-native-'+uuid.uuid4().hex[:10],'--token-stdin','--json',input=token['token']+'\n')
        devices=api('/devices'); assert len(devices)==1; device_id=devices[0]['id']
        selector={'device_ids':[device_id],'group_ids':[],'exclude_ids':[]}
        rollout={'kind':'all','canary_size':1,'batch_size':1,'observation_seconds':1,'failure_threshold':0}
        def deploy(version=None,policy=None,priority=100,canary=False):
            body={'selector':selector,'expected_device_ids':[device_id],'priority':priority,'target_mode':'snapshot','rollout':{**rollout,'kind':'canary' if canary else 'all'}}
            body.update({'version_id':version['id']} if version else {'policy':policy})
            return api('/deployments',body)
        def publish(config,name):
            draft=api('/configurations',{'name':name,'description':'Isolated native review; never ordinary fleet data','config':config,'graph':{'nodes':[],'edges':[]}})
            return api('/configurations/'+draft['id']+'/publish',{'revision':draft['revision'],'message':'Isolated native attempt fixture'})
        deploy(policy={'heartbeat_seconds':10,'sync_paused':False,'telemetry_enabled':False})
        version1=publish(good,'Synthetic verified baseline'); deployment1=deploy(version1)
        agent_log=(temp/'agent.log').open('wb'); log_handles.append(agent_log)
        agent=subprocess.Popen([str(args.agent),'run','--state-dir',str(state),'--json'],cwd=temp,stdout=agent_log,stderr=agent_log,creationflags=flags)
        def current(): return api('/devices/'+device_id)
        def healthy():
            d=current(); return d if d.get('apply_state')=='verified_applied' and d.get('reported_generation')==d.get('desired_generation') and d.get('actual_sha256')==version1['sha256'] else None
        first=until('real baseline Vector activation acknowledged over mTLS',healthy)
        assert hashlib.sha256(managed.read_bytes()).hexdigest()==version1['sha256']
        report['checks'].append({'name':'actual baseline activation and exact managed artifact','passed':True,'reported_generation':first['reported_generation'],'sha256':first['actual_sha256']})
        bad=json.loads(json.dumps(good)); bad['transforms']={'broken':{'type':'remap','inputs':['seed'],'source':'. = '}}; bad['sinks']['discard']['inputs']=['broken']
        version2=publish(bad,'Synthetic invalid native candidate'); deployment2=deploy(version2,priority=200,canary=True)
        def rejected():
            d=current(); local=json.loads((state/'state.json').read_text());
            return (d,local) if (d.get('apply_state')=='failed' or args.expect=='legacy' and d.get('reported_apply_state')=='failed') and local.get('error',{}).get('code')=='VALIDATION_FAILED' else None
        d,local=until('newer native candidate rejected and failure heartbeat observed',rejected)
        # Give the independent two-second scheduler a full cycle after the failure.
        time.sleep(3)
        target=api('/deployments/'+deployment2['id']+'/targets')['items'][0]
        summary=api('/deployments/'+deployment2['id']+'/summary')
        assert d['desired_generation']>first['reported_generation']
        assert d['reported_generation']==first['reported_generation']
        assert hashlib.sha256(managed.read_bytes()).hexdigest()==version1['sha256'],'failed validation replaced verified bytes'
        snapshot={'device_id':device_id,'desired_generation':d['desired_generation'],'reported_generation':d['reported_generation'],'apply_state':d['apply_state'],'reported_apply_state':d.get('reported_apply_state'),'configuration_attempt':d.get('configuration_attempt'),'local_configuration_attempt':local.get('configuration_attempt'),'local_failed_generation':local.get('failed_generation'),'local_error_code':local.get('error',{}).get('code'),'deployment_id':deployment2['id'],'deployment_status':summary['status'],'target_state':target['state'],'target_generation':target['generation'],'target_error':target.get('error'),'version_id':version2['id'],'sha256':version2['sha256'],'last_good_bytes_retained':True}
        report['candidate_failure']=snapshot
        if args.expect in ['before','legacy']:
            assert target['state']=='desired' and summary['status']=='active',snapshot
            if args.expect=='before':
                report['reproduced_defect']='Real failed newer candidate retained last-verified generation; deployment target stayed desired and canary stayed active despite failure_threshold=0.'
            else:
                assert not d.get('configuration_attempt') and d['apply_state']=='desired' and d.get('reported_apply_state')=='failed',snapshot
                report['legacy_compatibility']='Old agent failure is preserved as reported workload state, but never guessed as a current candidate attempt or counted as verified; target remains desired and canary does not advance.'
        else:
            assert target['state']=='failed' and summary['status']=='failed',snapshot
            assert target.get('error')=='VALIDATION_FAILED (validation)',snapshot
            attempt=d.get('configuration_attempt')
            assert attempt and attempt['generation']==d['desired_generation'] and attempt['version_id']==version2['id'] and attempt['sha256']==version2['sha256'],snapshot
        report['checks'].append({'name':'current failed candidate accounting ('+args.expect+')','passed':True})
        if args.expect=='after':
            # Stop only the enrolled fixture agent while sending deliberately late
            # and malformed mTLS messages with its private, disposable identity.
            # These negatives exercise real HTTP/server behavior, not agent emits.
            stop(agent); agent=None
            identity=json.loads((state/'identity.json').read_text())
            (temp/'client.pem').write_text(identity['credentials']['certificate_pem'])
            (temp/'client-key.pem').write_text(identity['private_key_pem'])
            tls=ssl.create_default_context(cafile=str(temp/'ca.pem'))
            tls.load_cert_chain(temp/'client.pem',temp/'client-key.pem')
            mtls=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=tls))
            signing=ed25519.Ed25519PublicKey.from_public_bytes(base64.b64decode(identity['credentials']['signing_public_key']))
            old_attempt=local['configuration_attempt']
            base_heartbeat={'protocol_version':1,'agent_version':'isolated-adversarial-fixture','vector_version':'0.58.0','configuration_mode':'restricted','reported_generation':local['reported_generation'],'policy_generation':local['highest_policy_generation'],'actual_sha256':local['actual_sha256'],'apply_state':'failed','local_paused':False,'remote_pause_acknowledged':False,'error':local['error'],'secret_revision':local.get('secret_revision',0)}
            def heartbeat(attempt,expected=200,**overrides):
                body={**base_heartbeat,'request_id':str(uuid.uuid4()),'boot_id':str(uuid.uuid4()),'nonce':base64.b64encode(os.urandom(32)).decode(),**overrides}
                if attempt is not None: body['configuration_attempt']=attempt
                req=urllib.request.Request(tls_origin+'/agent/v1/heartbeat',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='POST')
                try:
                    with mtls.open(req,timeout=12) as response: status=response.status; result=json.load(response)
                except urllib.error.HTTPError as e: status=e.code; result=json.load(e)
                assert status==expected,{'status':status,'expected':expected,'error_code':result.get('error',{}).get('code')}
                if status==200:
                    payload=base64.b64decode(result['payload']); signing.verify(base64.b64decode(result['signature']),payload)
                    manifest=json.loads(payload); assert manifest['nonce']==body['nonce'] and manifest['device_id']==device_id
                    return manifest
                return result
            def target_now(): return api('/deployments/'+deployment2['id']+'/targets')['items'][0]
            heartbeat(None)
            progress={key:value for key,value in old_attempt.items() if key!='error'}
            progress['state']='downloaded'
            heartbeat(progress,apply_state='downloaded',error=None)
            assert target_now()['state']=='failed','legacy gap erased terminal candidate failure'
            assert target_now().get('error')=='VALIDATION_FAILED (validation)','late progress erased the current sanitized failure reason'
            heartbeat({**old_attempt,'generation':d['desired_generation']+100},expected=409)
            assert target_now()['state']=='failed'
            report['checks'].append({'name':'terminal current failure survives legacy heartbeat followed by delayed nonterminal progress','passed':True,'proof_scope':'crafted_mTLS_after_actual_native_failure','future_generation_restore_fence_checked':True})
            retry=api('/devices/'+device_id+'/retry',{'expected_version_id':version2['id'],'expected_generation':d['desired_generation']})
            next_generation=retry['desired_generation']; assert next_generation==d['desired_generation']+1
            assert target_now()['state']=='desired'
            assert target_now().get('error') is None,'reviewed retry retained the prior generation error'
            stale_cases=[('older-generation',old_attempt),('wrong-version',{**old_attempt,'generation':next_generation,'version_id':str(uuid.uuid4())}),('wrong-template',{**old_attempt,'generation':next_generation,'sha256':'0'*64}),('legacy-no-identity',None)]
            for label,attempt_case in stale_cases:
                manifest=heartbeat(attempt_case)
                assert manifest['generation']==next_generation
                observed=current(); target=target_now()
                assert target['generation']==next_generation and target['state']=='desired',{'case':label,'target':target}
                assert target.get('error') is None,{'case':label,'target_error':target.get('error')}
                assert observed['apply_state'] not in ['failed','rolled_back'],{'case':label,'state':observed['apply_state']}
                assert not observed.get('configuration_attempt'),{'case':label,'attempt':observed.get('configuration_attempt')}
            report['checks'].append({'name':'stale mismatched and legacy failure messages cannot label reviewed retry generation','passed':True,'proof_scope':'crafted_mTLS_using_fresh_fixture_identity','cases':[name for name,_ in stale_cases]})
            for patch in [{'generation':-1},{'generation':9007199254740992},{'version_id':'not-a-uuid'},{'sha256':'oops'},{'state':'unknown-state'},{'secret_revision':-1},{'untrusted_extension':'must reject'}]:
                heartbeat({**old_attempt,'generation':next_generation,**patch},expected=400)
                assert target_now()['state']=='desired'
            report['checks'].append({'name':'malformed attempted identities reject before target mutation','passed':True,'proof_scope':'crafted_mTLS_using_fresh_fixture_identity','cases':7})
            # Restart the actual agent from its durable state: it receives the new
            # signed generation, retries real Vector validation, and reports only
            # that generation's candidate failure.
            agent=subprocess.Popen([str(args.agent),'run','--state-dir',str(state),'--json'],cwd=temp,stdout=agent_log,stderr=agent_log,creationflags=flags)
            def retried_failure():
                observed=current(); a=observed.get('configuration_attempt') or {}; target=target_now()
                return (observed,target) if a.get('generation')==next_generation and a.get('state')=='failed' and target['generation']==next_generation and target['state']=='failed' else None
            retried,target=until('restarted agent attributes actual retry failure to new signed generation',retried_failure)
            assert retried['reported_generation']==first['reported_generation']
            assert hashlib.sha256(managed.read_bytes()).hexdigest()==version1['sha256']
            assert target.get('error')=='VALIDATION_FAILED (validation)'
            report['checks'].append({'name':'real agent restart and newer retry failure accounting preserve last-good bytes and verified counter','passed':True,'desired_generation':next_generation,'reported_generation':retried['reported_generation'],'target_state':target['state'],'target_error':target['error']})
        report['passed']=True
    except Exception as error:
        report['failure']=str(error)
        raise
    finally:
        stop(agent); stop(server)
        for handle in log_handles: handle.close()
        report['processes_stopped']=all(p is None or p.poll() is not None for p in [agent,server])
        # The resolved target was returned directly by mkdtemp and must remain a
        # direct child of the OS temp directory with our exact fixed prefix.
        assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith('vectory-attempt-review-')
        shutil.rmtree(temp)
        report['private_fixture_removed']=not temp.exists()
        report['harness_sha256']=sha(__file__)
        (args.output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        print('Evidence: '+str(args.output/'report.json'),flush=True)

if __name__=='__main__': main()
