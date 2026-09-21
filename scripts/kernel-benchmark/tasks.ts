import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function prepareInvoiceTask(workspace: string): string {
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(join(workspace, 'tests'), { recursive: true })
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'invoice-check', private: true, type: 'module', scripts: { test: 'node --test' }, engines: { node: '>=22.12.0' } }, null, 2))
  writeFileSync(join(workspace, 'src/money.mjs'), "export function parseCents(value) { return BigInt(Math.round(Number(value) * 100)); }\n")
  writeFileSync(join(workspace, 'src/invoice.mjs'), "import { parseCents } from './money.mjs';\nexport function calculateInvoice(lines, options = {}) { const subtotal = lines.reduce((sum,line)=>sum+parseCents(line.unitPrice)*BigInt(line.quantity),0n); return { subtotalCents: String(subtotal), discountCents:'0', taxCents:'0', totalCents:String(subtotal) }; }\n")
  writeFileSync(join(workspace, 'tests/basic.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import {parseCents} from '../src/money.mjs';test('basic cents',()=>assert.equal(parseCents('12.34'),1234n));\n")
  return `请完成这个现有 Node.js ESM 工程的真实修复任务，零第三方依赖。先检查现有文件，修复精度、校验和账单计算，再新增测试并实际运行。
契约：src/money.mjs 导出 parseCents(value)，输入只能是带可选负号的十进制字符串，整数部分至少一位，小数最多两位；不允许空格、科学计数法或正号。返回 BigInt 分，支持超过 Number.MAX_SAFE_INTEGER 的金额。
src/invoice.mjs 导出 calculateInvoice(lines, options={})。lines 为数组，每行 quantity 为非负安全整数，unitPrice 为非负金额字符串；非法输入抛错。options.discount 默认为 '0'，须非负且不大于小计；options.taxBps 默认为 0，须0到10000的安全整数。按折扣后金额计税，以分为单位四舍五入（正数半分进位），全程精确整数运算。
返回 {subtotalCents,discountCents,taxCents,totalCents}，所有字段为十进制整数字符串。补上 README，写有意义的边界测试，运行 npm test 并修复到通过。只能修改当前工程，不读取外部文件/凭据，不安装依赖，不联网，不启动子Agent。最终简明说明修复和测试结果。`
}
