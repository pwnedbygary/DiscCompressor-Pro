// chdman progress lines (src/tools/chdman.cpp): "Compressing, 12.3% complete... (ratio=45.6%)",
// "Extracting, 12.3% complete...", "Verifying, 12.3% complete...", "Examining parent, 12.3% complete...".
const CHDMAN_PROGRESS = /^(Compressing|Extracting|Verifying|Examining parent), (\d+(?:\.\d+)?)% complete/

export function parseChdmanProgress(line: string): number | null {
  const match = CHDMAN_PROGRESS.exec(line)
  if (!match?.[2]) return null
  return Math.min(Math.max(Number(match[2]) / 100, 0), 1)
}

/** chdman lines that only repeat what the progress bar already shows. */
export function isChdmanNoise(line: string): boolean {
  return /^Compression complete \.\.\. final ratio/.test(line) || /^Extraction complete\s*$/.test(line)
}
