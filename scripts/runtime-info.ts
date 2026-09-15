import { getRuntimeInfo } from '../packages/agent-core/src/platform/runtime'

console.log(JSON.stringify(getRuntimeInfo(), null, 2))
