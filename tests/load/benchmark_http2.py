#!/usr/bin/env python3
"""Isolated native Go HTTP/2 transport measurement; no native Vector activation."""
import argparse
import asyncio
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import subprocess
import time
import benchmark as fixture
from cryptography.hazmat.primitives import serialization


async def scenario(args,count,binary,driver):
    directory=args.out/str(count)
    directory.mkdir(mode=0o700)
    fixture.pki(directory)
    fixture.protected(directory/'bootstrap',os.urandom(32).hex().encode())
    http_port,tls_port=fixture.free_port(),fixture.free_port()
    env={**os.environ,'VECTORY_DATA_DIR':str(directory/'state'),'VECTORY_HTTP_ADDR':f'127.0.0.1:{http_port}','VECTORY_AGENT_ADDR':f'127.0.0.1:{tls_port}','VECTORY_TLS_CERT':str(directory/'server.pem'),'VECTORY_TLS_KEY':str(directory/'server-key.pem'),'VECTORY_BOOTSTRAP_SECRET_FILE':str(directory/'bootstrap'),'VECTORY_DEVELOPMENT':'true','VECTORY_COOKIE_SECURE':'false','VECTORY_DASHBOARD_DIR':str(directory),'VECTORY_RELEASES_DIR':str(directory/'releases')}
    env.pop('VECTORY_VALIDATION_URL',None)
    flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
    with (directory/'server.log').open('wb') as log:
        process=subprocess.Popen([str(binary)],env=env,stdout=log,stderr=log,creationflags=flags)
        try: await fixture.wait_ready(f'http://127.0.0.1:{http_port}',process)
        finally: fixture.stop(process)
        identities,signing,digest,config_size=fixture.seed(directory,count)
        import base64
        plan={'server':f'https://127.0.0.1:{tls_port}','ca':str(directory/'server-ca.pem'),'signing_key':base64.b64encode(signing.public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)).decode(),'digest':digest,'duration':args.duration,'interval':args.interval,'devices':[{'id':identity,'certificate':str(cert),'key':str(key)} for identity,cert,key in identities]}
        fixture.protected(directory/'plan.json',json.dumps(plan).encode())
        process=subprocess.Popen([str(binary)],env=env,stdout=log,stderr=log,creationflags=flags)
        try:
            await fixture.wait_ready(f'http://127.0.0.1:{http_port}',process)
            observed=fixture.psutil.Process(process.pid)
            observed.cpu_percent(None)
            cpu_start=observed.cpu_times()
            before=sum(p.stat().st_size for p in (directory/'state').glob('vectory.db*'))
            started=time.perf_counter()
            print(f'{count}: isolated Go transport identities provisioned; measuring {args.duration}s',flush=True)
            child=await asyncio.create_subprocess_exec(str(driver),'--plan',str(directory/'plan.json'),'--out',str(directory/'transport.json'),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,creationflags=flags)
            samples=[]
            def observe():
                sample={'t':round(time.perf_counter()-started,3),'cpu_percent_one_core':observed.cpu_percent(None),'rss_bytes':observed.memory_info().rss,'database_bytes':(directory/'state/vectory.db').stat().st_size,'wal_bytes':(directory/'state/vectory.db-wal').stat().st_size if (directory/'state/vectory.db-wal').exists() else 0}
                try: sample['server_tcp_connections']=len(observed.net_connections(kind='tcp'))
                except fixture.psutil.Error: sample['server_tcp_connections']=None
                return sample
            async def monitor():
                while child.returncode is None:
                    samples.append(await asyncio.to_thread(observe))
                    await asyncio.sleep(1)
            async def collect():
                try: return await asyncio.wait_for(child.communicate(),timeout=args.duration+120)
                except asyncio.TimeoutError:
                    child.kill();await child.wait();raise RuntimeError('Go load driver exceeded bounded execution time')
            output,_=await asyncio.gather(collect(),monitor())
            if child.returncode!=0: raise RuntimeError(output[1].decode(errors='replace'))
            elapsed=time.perf_counter()-started
            cpu_end=observed.cpu_times()
            cpu=cpu_end.user+cpu_end.system-cpu_start.user-cpu_start.system
            report=json.loads((directory/'transport.json').read_text())
            with closing(sqlite3.connect(directory/'state/vectory.db',timeout=10)) as db:
                size=db.execute('PRAGMA page_size').fetchone()[0]*db.execute('PRAGMA page_count').fetchone()[0]
                telemetry=db.execute('SELECT count(*) FROM telemetry').fetchone()[0]
            report.update({'duration_requested_seconds':args.duration,'server_observation_seconds_including_client_setup':round(elapsed,3),'heartbeat_seconds':args.interval,'initial_jitter_seconds':[0,args.interval],'repeat_jitter_factor':[.8,1.2],'connection_idle_timeout_seconds':90,'configuration_bytes':config_size,'configuration_churn':0,'artifact_downloads':0,'scope':'real TLS1.3 mTLS signed-manifest Go transport simulation; offline seeded enrollment/desired state; no native Vector activation or rollout','server_cpu_seconds':round(cpu,3),'server_average_cpu_percent_one_core':round(cpu/elapsed*100,3),'server_peak_sampled_cpu_percent_one_core':max(s['cpu_percent_one_core'] for s in samples),'server_peak_rss_bytes':max(s['rss_bytes'] for s in samples),'sqlite_bytes_before':before,'sqlite_logical_bytes_after':size,'sqlite_wal_peak_bytes':max(s['wal_bytes'] for s in samples),'telemetry_rows_after':telemetry,'samples':samples})
            (directory/'result.json').write_text(json.dumps(report,indent=2)+'\n')
            return report
        finally: fixture.stop(process)


async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server',type=Path,required=True)
    parser.add_argument('--driver',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--agents',type=int,nargs='+',default=[100,1000,10000])
    parser.add_argument('--duration',type=float,default=70)
    parser.add_argument('--interval',type=float,default=60)
    args=parser.parse_args()
    if any(n<1 for n in args.agents) or args.duration<=0 or args.interval<=0: parser.error('counts and times must be positive')
    args.out=args.out.resolve();args.out.mkdir(parents=True,exist_ok=False)
    binary,driver=args.out/args.server.name,args.out/args.driver.name
    shutil.copyfile(args.server,binary);binary.chmod(0o700)
    shutil.copyfile(args.driver,driver);driver.chmod(0o700)
    hardware={'platform':platform.platform(),'processor':platform.processor(),'logical_cpus':fixture.psutil.cpu_count(),'physical_cpus':fixture.psutil.cpu_count(logical=False),'memory_total_bytes':fixture.psutil.virtual_memory().total,'server_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'driver_sha256':hashlib.sha256(driver.read_bytes()).hexdigest(),'build_profile':'server debug; Go load driver normal build','storage':str(args.out.anchor)+' local workspace volume; media verified separately in capacity report','measurement_notes':'shared development host, background work not suspended, loopback only, synthetic isolated fixtures, no native Vector activation or production capacity claim'}
    results=[]
    for count in args.agents:
        result=await scenario(args,count,binary,driver);results.append(result)
        print(json.dumps({k:result[k] for k in ['agents','requests','success','error_rate','protocol_counts','latency_successful_requests_ms','unique_agents_succeeded','server_peak_rss_bytes']}),flush=True)
        (args.out/'summary.json').write_text(json.dumps({'hardware':hardware,'results':results},indent=2)+'\n')


if __name__=='__main__': asyncio.run(main())
