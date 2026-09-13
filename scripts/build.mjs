import { spawnSync } from 'node:child_process';
const core=['contracts','config','persistence','moderation-core','provider-adapters'];
const targets=process.argv.includes('--core')?core:[...core,'api','worker','dashboard'];
for(const target of targets){
 const command=target==='dashboard' && process.argv.includes('--check')?'check':'build';
 const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['run',command,'--workspace=@moderator/'+target],{stdio:'inherit',shell:process.platform==='win32',env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});
 if(result.status!==0) process.exit(result.status??1);
}
