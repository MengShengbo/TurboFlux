import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const root=resolve(process.argv[2]);const {parseCents}=await import(pathToFileURL(resolve(root,'src/money.mjs')).href);const {calculateInvoice}=await import(pathToFileURL(resolve(root,'src/invoice.mjs')).href)
let assertions=0;const check=(fn)=>{fn();assertions++}
for(const [input,expected] of [['0',0n],['0.01',1n],['-12.30',-1230n],['9007199254740993.99',900719925474099399n],['001.2',120n]])check(()=>assert.equal(parseCents(input),expected))
for(const value of ['', ' 1','1 ', '+1','1e2','1.001','.1','1.',1,null,NaN])check(()=>assert.throws(()=>parseCents(value)))
check(()=>assert.deepEqual(calculateInvoice([{quantity:3,unitPrice:'0.10'}]),{subtotalCents:'30',discountCents:'0',taxCents:'0',totalCents:'30'}))
check(()=>assert.deepEqual(calculateInvoice([{quantity:1,unitPrice:'0.01'}],{taxBps:5000}),{subtotalCents:'1',discountCents:'0',taxCents:'1',totalCents:'2'}))
check(()=>assert.deepEqual(calculateInvoice([{quantity:2,unitPrice:'10.25'}],{discount:'0.50',taxBps:825}),{subtotalCents:'2050',discountCents:'50',taxCents:'165',totalCents:'2165'}))
check(()=>assert.equal(calculateInvoice([{quantity:1,unitPrice:'9007199254740993.99'}]).totalCents,'900719925474099399'))
check(()=>assert.deepEqual(calculateInvoice([]),{subtotalCents:'0',discountCents:'0',taxCents:'0',totalCents:'0'}))
for(const line of [{quantity:-1,unitPrice:'1'},{quantity:.1,unitPrice:'1'},{quantity:1,unitPrice:'-1'},{quantity:1e20,unitPrice:'1'}])check(()=>assert.throws(()=>calculateInvoice([line])))
for(const options of [{discount:'1'},{discount:'-1'},{taxBps:-1},{taxBps:10001},{taxBps:.5}])check(()=>assert.throws(()=>calculateInvoice([],options)))
check(()=>assert.ok(existsSync(resolve(root,'README.md'))))
const tests=spawnSync(process.execPath,['--test'],{cwd:root,encoding:'utf8',timeout:30000});check(()=>assert.equal(tests.status,0,tests.stdout+tests.stderr))
console.log(JSON.stringify({passed:true,assertions,projectTests:tests.stdout},null,2))
