"""Disposable scheduler regression; no preview state or processes are accessed."""
import argparse, http.cookiejar, importlib.util, json, os
from pathlib import Path
import shutil, sqlite3, subprocess, tempfile, time, urllib.request, urllib.error, uuid
from datetime import datetime, timedelta, timezone
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('helpers',ROOT/'tests/security/attempt-native.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server',type=Path,required=True)
parser.add_argument('--expect',choices=['before','after'],required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args();binary=args.server.resolve()
report={'recorded_at':h.utc(),'scope':'Real native server and HTTP deployment actions in fresh temporary state. Three synthetic SQLite device rows; no real agent, workload, preview, or credential access.','expectation':args.expect,'server_sha256':h.sha(binary),'passed':False,'checks':[]}
temp=Path(tempfile.mkdtemp(prefix='vectory-core-review-')).resolve();process=None;log=None
try:
    copied=temp/'server.exe';shutil.copyfile(binary,copied)
    port=h.free_port();origin=f'http://127.0.0.1:{port}'
    bootstrap=os.urandom(32).hex();(temp/'bootstrap').write_text(bootstrap)
    env={k:v for k,v in os.environ.items() if not k.upper().startswith('VECTORY_') and k.upper() not in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']}
    env.update(VECTORY_DATA_DIR=str(temp/'state'),VECTORY_HTTP_ADDR=f'127.0.0.1:{port}',VECTORY_DEVELOPMENT='true',VECTORY_COOKIE_SECURE='false',VECTORY_BOOTSTRAP_SECRET_FILE=str(temp/'bootstrap'),VECTORY_DASHBOARD_DIR=str(temp),VECTORY_RELEASES_DIR=str(temp/'releases'))
    log=(temp/'server.log').open('wb')
    process=subprocess.Popen([str(copied)],cwd=temp,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));csrf=''
    def api(path,body=None,expected=200,method=None):
        req=urllib.request.Request(origin+'/api/v1'+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'Content-Type':'application/json','X-CSRF-Token':csrf})
        try: response=opener.open(req,timeout=10)
        except urllib.error.HTTPError as e:response=e
        with response:status=response.status;result=json.load(response)
        assert status==expected,(path,status,expected)
        return result
    for _ in range(100):
        try:api('/status');break
        except urllib.error.URLError:time.sleep(.1)
    csrf=api('/bootstrap',{'bootstrap_secret':bootstrap,'name':'Synthetic review','email':'review@example.invalid','password':os.urandom(32).hex()})['csrf_token']
    ids=[str(uuid.uuid4()) for _ in range(3)]
    with sqlite3.connect(temp/'state/vectory.db') as db:
        for i,id in enumerate(ids):
            d={'id':id,'name':f'Fixture {i}','vector_version':'0.58.0','last_seen':h.utc(),'apply_state':'unmanaged','reported_generation':0,'policy_generation':0}
            db.execute('INSERT INTO devices(id,name,data) VALUES(?,?,?)',(id,d['name'],json.dumps(d)))
    db.close()
    selector={'device_ids':ids,'group_ids':[],'exclude_ids':[]}
    def payload(seconds,priority,canary=False):
        return {'policy':{'heartbeat_seconds':seconds,'sync_paused':False,'telemetry_enabled':True},'selector':selector,'priority':priority,'target_mode':'snapshot','rollout':{'kind':'canary' if canary else 'all','canary_size':1,'batch_size':1,'observation_seconds':60,'failure_threshold':0}}
    scheduled_body=payload(30,200);scheduled_body['scheduled_at']=(datetime.now(timezone.utc)+timedelta(seconds=10)).isoformat()
    scheduled=api('/deployments',scheduled_body)
    canary=api('/deployments',payload(120,100,True))
    assert sum(t['generation']>0 for t in canary['targets'])==1
    direct=api('/deployments/preview',payload(30,200))
    assert direct['blockers'][0]['code']=='ACTIVE_CANARY_OVERLAP'
    api('/deployments',payload(30,200),409)
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        after=api('/deployments/'+scheduled['id'])
        if after['status']!='scheduled':break
        time.sleep(.3)
    fleet=api('/devices');canary_after=api('/deployments/'+canary['id'])
    bypass=sum(d.get('policy_assignment',{}).get('id')==scheduled['id'] for d in fleet)
    reproduced=after['status']=='active' and canary_after['status']=='active' and bypass==3
    report['checks'].append({'name':'schedule activation rechecks active-canary admission','bypass_reproduced':reproduced,'direct_preview_blocker':'ACTIVE_CANARY_OVERLAP','equivalent_direct_create_status':409,'scheduled_status_after_due':after['status'],'original_canary_status':canary_after['status'],'canary_admitted_targets':sum(t['generation']>0 for t in canary_after['targets']),'schedule_admitted_targets':sum(t['generation']>0 for t in after['targets']),'devices_superseded_by_schedule':bypass,'target_states':[t['state'] for t in after['targets']],'target_errors':[t['error'] for t in after['targets']]})
    if args.expect=='before':assert reproduced,'suspected failure was not reproduced'
    else:
        assert after['status']=='failed' and canary_after['status']=='active' and bypass==0
        assert all(t['state']=='blocked' and t['generation']==0 and t.get('released_at') is None and t['error']=='Scheduled activation blocked by an active canary; pause or cancel it, then create a new reviewed deployment' for t in after['targets'])
        assert sum(t['generation']>0 for t in canary_after['targets'])==1
    report['passed']=True
finally:
    h.stop(process)
    if log:log.close()
    assert temp.parent==Path(tempfile.gettempdir()).resolve() and temp.name.startswith('vectory-core-review-')
    shutil.rmtree(temp)
    report['fixture_removed']=not temp.exists();report['process_stopped']=process is None or process.poll() is not None
    report['harness_sha256']=h.sha(__file__)
    output=args.output.resolve();output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
