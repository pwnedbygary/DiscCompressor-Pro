/** The project's GitHub repository, which has the releases and the issue tracker. */
export const REPOSITORY_URL = 'https://github.com/pwnedbygary/DiscCompressor-Pro'

/** The page of a release, with its notes and files. */
export function releaseUrl(version: string): string {
  return `${REPOSITORY_URL}/releases/tag/v${version}`
}
