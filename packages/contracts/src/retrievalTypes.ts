export interface RetrievedResource {
  path: string
  kind: 'file' | 'directory'
  state: 'found' | 'matched' | 'read'
  line?: number
  endLine?: number
  preview?: string
  lines?: Array<{ line: number; text: string; matched?: boolean }>
  matchCount?: number
  textTruncated?: boolean
}

/** Execution facts shared by model output, conversation history, and clients. */
export interface RetrievalResult {
  operation: 'search_files' | 'search_content' | 'read_file' | 'list_directory'
  scope: string
  query?: string
  outputMode?: 'content' | 'files' | 'count'
  resources: RetrievedResource[]
  total?: number
  totalIsExact: boolean
  truncated: boolean
  nextOffset?: number
  warning?: string
}
