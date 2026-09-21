import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { summarizeModelRequests, isModelRequestRecord } from '@turboflux/contracts/modelUsage'
import type { ModelRequestRecord } from '@turboflux/contracts/agentTypes'
import type { AnyAppendConversationEventInput } from '@turboflux/contracts/conversationEvent'
import { ConversationEventNormalizer } from '@turboflux/conversations/events/conversationEventNormalizer'
import { ConversationEventLog } from '@turboflux/conversations/events/conversationEventLog'
import { ConversationRuntimeRepositoryV2 } from '@turboflux/conversations/conversations/conversationRuntimeRepositoryV2'
import type { PersistedConversation } from '@turboflux/conversations/conversations/types'

const scriptRoot=dirname(fileURLToPath(import.meta.url))
const { values }=parseArgs({ options: {
  mode:{type:'string',default:'replay'}, output:{type:'string'}, fixture:{type:'string'}, root:{type:'string'}, conversation:{type:'string'}, help:{type:'boolean'},
}, strict:true })
if(values.help){console.log('npm run bench:kernel -- --mode replay --output /tmp/kernel-report\nModes: replay (real captured usage -> disk -> fresh process), inspect (read a benchmark-created repository in a fresh process). No provider call or credential is used.');process.exit(0)}
if(values.mode==='inspect'){
  if(!values.root||!values.conversation)throw new Error('inspect requires --root and --conversation')
  const repo=new ConversationRuntimeRepositoryV2(resolve(values.root),'benchmark-profile','workspace-12345678','/benchmark-workspace')
  const conversation=repo.load(values.conversation)
  if(!conversation)throw new Error('Benchmark conversation not found')
  console.log(JSON.stringify(summarizeModelRequests(conversation.modelRequests??[])));process.exit(0)
}
if(values.mode!=='replay')throw new Error(`Unknown mode: ${values.mode}`)
const output=resolve(values.output??join(tmpdir(),'turboflux-kernel-'+Date.now()))
if(existsSync(join(output,'report.json')))throw new Error('Report already exists; choose a new output directory')
mkdirSync(output,{recursive:true})
const fixturePath=resolve(values.fixture??join(scriptRoot,'kernel-benchmark/fixtures/long-task-usage.json'))
const fixture=JSON.parse(readFileSync(fixturePath,'utf8')) as { records:ModelRequestRecord[]; expected:{input:number;cached:number;output:number} }
assert.ok(fixture.records.every(isModelRequestRecord),'Invalid usage fixture')
const storage=mkdtempSync(join(tmpdir(),'turboflux-kernel-ledger-'))
const id=randomUUID()
const conversation:PersistedConversation={id,title:'Kernel accounting benchmark',workspacePath:'/benchmark-workspace',createdAt:1,updatedAt:1,mode:'vibe',provider:'openai',model:'gpt-6-astra',turnCount:0,turns:[]}
const repo=new ConversationRuntimeRepositoryV2(storage,'benchmark-profile','workspace-12345678','/benchmark-workspace')
const normalizer=new ConversationEventNormalizer(id)
const log=new ConversationEventLog(id)
let appendMs=0;let events=0
const emit=(inputs:readonly AnyAppendConversationEventInput[])=>{
 for(const event of log.appendMany(inputs)){
  const start=performance.now();repo.appendCanonical(event,conversation);appendMs+=performance.now()-start;events++
  // A replayed envelope must not append or count another request.
  repo.appendCanonical(event,conversation)
 }
}
try{
 emit(normalizer.startRun({runId:'baseline-run',objective:'Replay captured usage',at:1}))
 for(const record of fixture.records){
  const start={...record,status:'running' as const,usage:{source:'unknown' as const},usageFinal:false,updatedAt:record.startedAt,endedAt:undefined,durationMs:undefined}
  emit(normalizer.normalizeAgent({type:'model:request',request:start},{at:start.startedAt}))
  emit(normalizer.normalizeAgent({type:'model:request',request:{...start,usage:{...record.usage,output:0,total:record.usage.input},updatedAt:record.updatedAt-1}},{at:record.updatedAt-1}))
  emit(normalizer.normalizeAgent({type:'model:request',request:record},{at:record.updatedAt}))
  emit(normalizer.normalizeAgent({type:'model:request',request:record},{at:record.updatedAt}))
 }
 emit(normalizer.finishRun({outcome:'completed',at:fixture.records.at(-1)!.updatedAt}))
 const expected=summarizeModelRequests(fixture.records)
 assert.equal(expected.totals.input,fixture.expected.input);assert.equal(expected.totals.cached,fixture.expected.cached);assert.equal(expected.totals.output,fixture.expected.output)
 const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'--mode','inspect','--root',storage,'--conversation',id],{
  cwd:resolve(scriptRoot,'..'),encoding:'utf8',env:{...process.env,TSX_TSCONFIG_PATH:resolve(scriptRoot,'../tsconfig.open-source.json')},timeout:30000,
 })
 assert.equal(child.status,0,child.stderr)
 const restored=JSON.parse(child.stdout)
 assert.deepEqual(restored,expected)
 const report={schemaVersion:1,mode:'captured-usage-replay',providerCalls:0,passed:true,fixture:fixturePath,events,duplicateReplayOfEachEnvelope:true,freshProcessRestore:true,appendMs:Number(appendMs.toFixed(2)),expected,restored,notes:'No current model-cache performance claim. This verifies exact accounting and restart recovery of measured historical usage.'}
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({output,passed:true,attempts:expected.attempts,input:expected.totals.input,cached:expected.totals.cached,cacheHitRate:expected.cacheHitRate,freshProcessRestore:true},null,2))
}finally{rmSync(storage,{recursive:true,force:true})}
