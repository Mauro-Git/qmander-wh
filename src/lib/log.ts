import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_DIR = process.env.LOG_DIR ?? '/app/logs'
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

export function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const now = new Date()
  const line = `[${now.toISOString()}] [${level}] ${msg}\n`

  // Consola
  console[level === 'info' ? 'log' : level](line.trimEnd())

  // Archivo diario (ej: 2026-07-23.log)
  const filename = `${now.toISOString().slice(0, 10)}.log`
  try {
    appendFileSync(join(LOG_DIR, filename), line)
  } catch { /* no romper el servidor si falla la escritura */ }
}
