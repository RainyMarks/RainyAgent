import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-client-ui-rainy', [
  'lib/types/index.js',
  'lib/types/native-tools-protocol.js',
  'lib/types/ide-files-protocol.js',
  'lib/types/ide-execution-protocol.js',
  'lib/types/runtime-protocol.js',
  'lib/types/strata-protocol.js',
  'lib/types/modules-protocol.js',
])
