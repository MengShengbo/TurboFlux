import {app,safeStorage} from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {register} from 'tsx/esm/api'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'turboflux-kernel-bench-'))
app.setName('TurboFlux');app.setPath('userData',profile)
app.whenReady().then(async()=>{
 let unregister
 try{
  app.dock?.hide()
  if(!safeStorage.isEncryptionAvailable())throw new Error('Native credential store is unavailable')
  globalThis.__kernelBenchmarkCredentials={protect:p=>safeStorage.encryptString(p.toString('base64url')),unprotect:c=>Buffer.from(safeStorage.decryptString(c),'base64url')}
  unregister=register({tsconfig:path.join(root,'tsconfig.open-source.json')})
  await import('./live.ts')
 }catch(error){console.error(error.stack||error.message);process.exitCode=1}
 finally{delete globalThis.__kernelBenchmarkCredentials;await unregister?.();app.quit()}
})
app.on('will-quit',()=>{try{fs.rmSync(profile,{recursive:true,force:true})}catch{}})
