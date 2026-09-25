/**
 * Downloads for the build scripts. Network errors, server errors (5xx) and
 * rate limiting (429) are retried with backoff; other HTTP errors, such as a
 * wrong URL, fail at once.
 */
import { createHash } from 'node:crypto'

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

/** An error's message followed by the reason Node gives for a failed fetch (e.g. ECONNRESET). */
export function describe(error) {
  if (!(error instanceof Error)) return String(error)
  const reason = error.cause instanceof Error ? error.cause.message : null
  return reason && !error.message.includes(reason) ? `${error.message}: ${reason}` : error.message
}

export async function fetchWithRetry(url, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new HttpError(response.status)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      const retryable = !(error instanceof HttpError) || error.status === 429 || error.status >= 500
      if (!retryable || attempt === attempts) throw new Error(`${url}: ${describe(error)}`, { cause: error })
      const delay = 2000 * 2 ** attempt
      console.log(`Retrying ${url} in ${delay / 1000} s (${describe(error)})`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Throw unless `data` hashes to `expected` (`algorithm` and `encoding` as for crypto.createHash). */
export function verifyDigest(data, expected, label, algorithm = 'sha256', encoding = 'hex') {
  const actual = createHash(algorithm).update(data).digest(encoding)
  if (actual !== expected) throw new Error(`${label} failed checksum verification: expected ${algorithm} ${expected}, got ${actual}`)
}
