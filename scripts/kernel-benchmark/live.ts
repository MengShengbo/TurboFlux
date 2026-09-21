import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { loadConfig } from '@turboflux/models/config'
import { setCredentialProtection, type CredentialProtection } from '@turboflux/models/credentialStore'
import { configureActiveProfilePaths } from '@turboflux/platform/profilePaths'
import { createAgentRuntime } from '@turboflux/agent-runtime/runtime/agentRuntime'
import { summarizeModelRequests } from '@turboflux/contracts/modelUsage'
import type { ModelRequestRecord } from '@turboflux/contracts/agentTypes'
import type { PersistedConversation } from '@turboflux/conversations/conversations/types'
import { ConversationEventLog } from '@turboflux/conversations/events/conversationEventLog'
import { ConversationEventNormalizer } from '@turboflux/conversations/events/conversationEventNormalizer'
import { ConversationRuntimeRepositoryV2 } from '@turboflux/conversations/conversations/conversationRuntimeRepositoryV2'
import { prepareInvoiceTask } from './tasks'

const {values}=parseArgs({args:process.argv.slice(2),options:{output:{type:'string'},task:{type:'string',default:'invoice-fix'}},strict:true})
if(!values.output)throw new Error('Live benchmark requires an explicit --output directory')
if(values.task!=='invoice-fix')throw new Error('This runner currently supports invoice-fix; full B1-B6 suite remains in progress')
const output=resolve(values.output)
if(existsSync(output))throw new Error('Output directory already exists')
mkdirSync(output,{recursive:true});const workspace=join(output,'workspace');mkdirSync(workspace)
const profileId=JSON.parse(readFileSync(join(homedir(),'.turboflux/profiles.json'),'utf8')).activeProfileId
configureActiveProfilePaths({configRoot:join(homedir(),'.turboflux/profiles',profileId,'config'),conversationsRoot:join(output,'config-conversations'),userSkillsRoot:join(output,'skills'),globalMcpSettingsPath:join(output,'mcp.json')})
setCredentialProtection((globalThis as unknown as {__kernelBenchmarkCredentials:CredentialProtection}).__kernelBenchmarkCredentials)
const config=await loadConfig();if(!config.apiKey)throw new Error('No configured model credential')
const id=randomUUID();const prompt=prepareInvoiceTask(workspace)
const runtime=createAgentRuntime({workspacePath:workspace,workspaceName:values.task,config:{...config,gitEnabled:false},conversationId:id,approvalPolicy:'full',capabilityProfile:'danger-full-access',runtimeStoragePath:join(output,'runtime'),runtimeLogsRoot:join(output,'logs'),memoryRoot:join(output,'memory'),userSkillsRoot:join(output,'skills'),connectMcp:false})
const normalizer=new ConversationEventNormalizer(id);const log=new ConversationEventLog(id)
const storage=join(output,'conversations-v2');const repo=new ConversationRuntimeRepositoryV2(storage,'benchmark-profile','workspace-12345678',workspace)
const conversation:PersistedConversation={id,title:'Invoice regression benchmark',workspacePath:workspace,createdAt:Date.now(),updatedAt:Date.now(),mode:'vibe',model:config.model,provider:config.provider,turnCount:0,turns:[]}
const runId=randomUUID()
for(const e of log.appendMany(normalizer.startRun({runId,objective:prompt,at:Date.now()})))repo.appendCanonical(e,conversation)
const records:ModelRequestRecord[]=[];let tools=0;const started=performance.now();let peakHeap=process.memoryUsage().heapUsed
const files=['packages/agent-runtime/src/agentEngine.ts','packages/agent-runtime/src/runtime/modelRequestTracker.ts','packages/conversations/src/conversations/conversationRuntimeRepositoryV2.ts']
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const source=Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(join(repository,f))).digest('hex')]))
writeFileSync(join(output,'environment.json'),JSON.stringify({model:config.model,reasoning:config.reasoning,task:values.task,source,prompt},null,2))
runtime.engine.subscribe(event=>{
 const at=Date.now()
 for(const e of log.appendMany(normalizer.normalizeAgent(event,{at})))repo.appendCanonical(e,conversation)
 if(event.type==='model:request'){
  records.push(structuredClone(event.request));appendFileSync(join(output,'model-requests.jsonl'),JSON.stringify(event.request)+'\n')
  if(event.request.status!=='running')console.log(JSON.stringify({attempt:event.request.id,status:event.request.status,usage:event.request.usage,durationMs:event.request.durationMs}))
 }
 if(event.type==='tool:result'){tools++;appendFileSync(join(output,'tool-results.jsonl'),JSON.stringify(event.toolResult)+'\n');console.log(JSON.stringify({tool:event.toolResult.name,isError:event.toolResult.isError,preview:event.toolResult.output.slice(0,160)}))}
})
const interval=setInterval(()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);console.log(JSON.stringify({elapsedSeconds:Math.round((performance.now()-started)/1000),tools,summary:summarizeModelRequests(records)}))},15000)
const stop=setTimeout(()=>runtime.engine.stop(),15*60000)
try{
 const turns=await runtime.engine.run(prompt,{userTurnId:runId});await runtime.engine.waitUntilIdle();conversation.turns=turns;conversation.turnCount=turns.length
 for(const e of log.appendMany(normalizer.finishRun({outcome:'completed',at:Date.now()})))repo.appendCanonical(e,conversation)
 const live=summarizeModelRequests(records);const loaded=new ConversationRuntimeRepositoryV2(storage,'benchmark-profile','workspace-12345678',workspace).load(id)!
 const restored=summarizeModelRequests(loaded.modelRequests??[]);assert.deepEqual(restored,live)
 const child=spawnSync('node',['--import','tsx',join(repository,'scripts/kernel-benchmark.ts'),'--mode','inspect','--root',storage,'--conversation',id],{
  cwd:repository,encoding:'utf8',env:{...process.env,TSX_TSCONFIG_PATH:join(repository,'tsconfig.open-source.json')},timeout:30000,
 })
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),live)
 const verification=spawnSync('node',[join(dirname(fileURLToPath(import.meta.url)),'verify-invoice.mjs'),workspace],{encoding:'utf8',timeout:30000})
 writeFileSync(join(output,'verification.log'),verification.stdout+verification.stderr)
 const report={passed:verification.status===0,accountingMatches:true,freshProcessAccountingMatches:true,elapsedMs:performance.now()-started,tools,peakHeap,live,restored,source,completedPhase:runtime.engine.getRunState(),answer:turns.filter(t=>t.role==='assistant'&&!t.metadata?.internal&&!t.toolCalls?.length).map(t=>t.content).join('\n')}
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
 assert.equal(verification.status,0,'Independent engineering verification failed')
}catch(error){
 writeFileSync(join(output,'failure.json'),JSON.stringify({message:error instanceof Error?error.message:String(error),summary:summarizeModelRequests(records),tools},null,2));throw error
}finally{clearInterval(interval);clearTimeout(stop);await runtime.destroy()}
