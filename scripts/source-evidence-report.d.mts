export function sanitizeSourceEvidenceReport<T>(report: T): T

export function projectEvidenceFields(value: unknown, schema: unknown): unknown

export function writeSourceEvidenceReportAtomically<T>(reportPath: string, report: T): Promise<T>

export function writeSourceEvidenceTextAtomically(path: string, contents: string): Promise<string>
