"""Native re-adoption validation only; synthetic state, no daemon or network."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[2]
def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--agent', type=Path, required=True)
    p.add_argument('--vector', type=Path, default=ROOT / '.local/tools/vector-0.58.0/bin/vector.exe')
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    agent, vector, output = args.agent.resolve(), args.vector.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    checks = []
    for full in [False, True]:
        fixture = output / ('fixture-' + str(uuid.uuid4()))
        state, managed_dir, binaries = fixture/'state', fixture/'managed', fixture/'bin'
        managed_dir.mkdir(parents=True); binaries.mkdir()
        managed, binary = managed_dir/'managed.json', binaries/'vector.exe'
        shutil.copyfile(vector,binary)
        data_dir=fixture/'vector-data';data_dir.mkdir()
        config = {'data_dir':str(data_dir),'sources': {'synthetic': {'type': 'demo_logs', 'format': 'json'}}, 'sinks': {'discard': {'type': 'blackhole', 'inputs': ['synthetic']}}}
        managed.write_text(json.dumps(config),encoding='utf-8')
        commands=[]
        def call(*argv):
            run=subprocess.run([str(agent),*map(str,argv)],capture_output=True,text=True,timeout=80,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            commands.append({'command':[str(a).replace(str(fixture),'<disposable-fixture>') for a in argv], 'exit_code':run.returncode})
            return run
        install=['install','--state-dir',state,'--vector-binary',binary,'--managed-config',managed,'--adopt']
        if full: install.append('--allow-full-vector-config')
        initial=call(*install);assert initial.returncode==0,initial.stderr
        settings_path=state/'settings.json'
        settings=json.loads(settings_path.read_text())
        settings['capability_policy']['allowed_file_roots']=[str(data_dir)]
        original_digest=settings['vector_binary_sha256']
        settings['future_extension']={'exact':18446744073709551615,'array':[None,False]}
        settings_path.write_text(json.dumps(settings),encoding='utf-8')
        good=state/('good-'+digest(managed)+'.json');shutil.copyfile(managed,good)
        st=json.loads((state/'state.json').read_text())
        st.update(device_id='synthetic-re-adoption-identity',accepted=True,highest_generation=42,highest_policy_generation=19,reported_generation=40,actual_sha256=digest(managed),last_good_sha256=digest(good),failed_generation=42,failed_effective_sha256='a'*64,secret_revision=8,applied_secret_revision=7,apply_state='rolled_back',policy={'heartbeat_seconds':120,'sync_paused':True,'telemetry_enabled':False},remote_pause_acknowledged=True)
        st['configuration_attempt']={'generation':42,'version_id':'7aa4f227-b652-4b0f-9a93-4fc3cfa7031d','sha256':'b'*64,'state':'rolled_back','secret_revision':8,'error':{'code':'APPLY_ROLLED_BACK','stage':'rollback','message':'Synthetic prior failure'}}
        (state/'state.json').write_text(json.dumps(st),encoding='utf-8')
        for name in ['paused','credentials.json','identity.json','private-key.pem','origin.json']:
            (state/name).write_text('synthetic preservation fixture, never used as a credential',encoding='utf-8')
        # Paused manual content intentionally differs from recorded recovery bytes.
        config['sources']['synthetic']['interval']=2.0
        managed.write_text(json.dumps(config),encoding='utf-8')
        preserved={path:digest(path) for path in [*state.iterdir(),managed] if path.is_file() and path.name not in ['settings.json','agent.lock']}
        if full:
            replacement=fixture/'alternate'/'vector.exe';replacement.parent.mkdir();shutil.copyfile(vector,replacement)
        else: replacement=binary
        with replacement.open('ab') as f:f.write(b'\nSynthetic independently approved same-version PE overlay\n')
        expected=digest(replacement);assert expected!=original_digest
        bad=call('re-adopt','--state-dir',state,'--vector-binary',replacement,'--expected-sha256','0'*64,'--json')
        assert bad.returncode!=0 and json.loads(settings_path.read_text())==settings
        # The same-path wrong-pin diagnostic must be exactly one JSON document.
        if not full:
            doctor=call('doctor','--state-dir',state,'--json'); diagnostic=json.loads(doctor.stdout)
            assert doctor.returncode!=0 and diagnostic['binary_integrity'] is False
            assert 're-adopt' in diagnostic['error'] and 're-adopt' in diagnostic['diagnostics']['next_action']
        accepted=call('re-adopt','--state-dir',state,'--vector-binary',replacement,'--expected-sha256',expected,'--json')
        assert accepted.returncode==0,accepted.stderr+accepted.stdout
        receipt=json.loads(accepted.stdout)
        assert receipt['sha256']==expected and receipt['vector_binary']==str(replacement)
        assert receipt['vector_version']=='0.58.0' and receipt['validated']==['managed','last_good'] and receipt['workload_started'] is False
        current=json.loads(settings_path.read_text());wanted={**settings,'vector_binary':str(replacement),'vector_binary_sha256':expected}
        assert current==wanted
        assert all(digest(path)==sha for path,sha in preserved.items())
        after_settings=digest(settings_path)
        repeated=call('re-adopt','--state-dir',state,'--expected-sha256',expected.upper(),'--json')
        assert repeated.returncode==0 and json.loads(repeated.stdout)['changed'] is False
        assert digest(settings_path)==after_settings
        doctor=call('doctor','--state-dir',state,'--json');diagnostic=json.loads(doctor.stdout)
        assert doctor.returncode==0 and diagnostic['binary_integrity'] is True
        assert all(digest(path)==sha for path,sha in preserved.items())
        checks.append({'mode':'full' if full else 'restricted','path_change':full,'passed':True,'settings_only_changed':True,'state_credentials_pause_managed_lastgood_unchanged':True,'same_pin_no_write':True,'native_validate_both_artifacts':True,'doctor_single_json':True,'commands':commands,'fixture_path':str(fixture),'original_digest':original_digest,'approved_digest':expected})
    files=['agent/cmd/vectory/main.go','agent/internal/agent/readoption.go','agent/internal/agent/readoption_windows.go','agent/internal/agent/reconcile.go','agent/internal/agent/vector.go']
    report={'recorded_at':datetime.now(timezone.utc).isoformat(),'passed':True,'groups':len(checks),'scope':'Windows actual Vector0.58.0 version/validate/test command path with synthetic stopped-agent state. Same-version PE overlays in disposable copies; no daemon, workload activation, services, server, enrollment, real credentials or network configuration. Synthetic last-good counters are preservation fixtures, not verified activation evidence.','agent':{'path':str(agent),'sha256':digest(agent)},'checks':checks,'source_sha256':{path:digest(ROOT/path) for path in files},'harness_sha256':digest(Path(__file__)),'limits':['Only Windows native execution. Same supported version with different bytes, not arbitrary upstream upgrades.','Settings protection qualified separately. No OS service or real fleet state involved.']}
    (output/'report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':True,'report':str(output/'report.json')}))

if __name__=='__main__':main()
