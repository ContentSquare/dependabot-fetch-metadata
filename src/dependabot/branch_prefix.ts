import * as core from '@actions/core'
import { GitHub } from '@actions/github/lib/utils'
import * as YAML from 'yaml'
import type { Context } from './github-context'

export interface BranchPrefix {
  // The prefix as it appears at the start of the branch name, e.g. "dependabot" or "chore-deps"
  prefix: string
  // The character expected right after the prefix. When undefined, any character is accepted.
  separator?: string
}

export interface BranchPrefixMatch {
  prefix: string
  delimiter: string
}

// Dependabot branches start with "dependabot" by default. Any character following it is used as the delimiter, so
// branches generated with a custom `pull-request-branch-name.separator` keep being supported.
export const DEFAULT_BRANCH_PREFIX: BranchPrefix = { prefix: 'dependabot' }

const DEFAULT_SEPARATOR = '/'
const SUPPORTED_SEPARATORS = ['/', '-', '_']
const DEPENDABOT_CONFIG_PATHS = ['.github/dependabot.yml', '.github/dependabot.yaml']

/**
 * Normalizes a `pull-request-branch-name.prefix` the same way Dependabot does when it generates a branch name.
 *
 * See `Dependabot::PullRequestCreator::BranchNamer::Base#sanitize_branch_name` in the Ruby codebase.
 */
export function normalizeBranchPrefix (prefix: string, separator: string): string {
  return prefix
    .replace(/[^A-Za-z0-9/\-_.(){}]/g, '')
    .replace(/\/\./g, '/dot-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .join(separator)
}

/**
 * Builds the branch prefixes from the `branch-prefix` input, a comma or newline separated list of prefixes.
 * Since the separator is unknown, a candidate is created for each separator supported by Dependabot.
 */
export function parseBranchPrefixInput (input: string): BranchPrefix[] {
  const prefixes = input.split(/[,\n]/).map(prefix => prefix.trim()).filter(prefix => prefix.length > 0)

  return uniqueBranchPrefixes(prefixes.flatMap(prefix =>
    SUPPORTED_SEPARATORS.map(separator => ({ prefix: normalizeBranchPrefix(prefix, separator), separator }))
  ))
}

/**
 * Extracts the custom branch prefixes from the content of a `dependabot.yml` file, looking at the
 * `pull-request-branch-name` option of each `updates` entry and each `multi-ecosystem-groups` entry.
 */
export function parseBranchPrefixConfig (configContent: string): BranchPrefix[] {
  let config: unknown
  try {
    config = YAML.parse(configContent, { merge: true })
  } catch (error) {
    core.debug(`Unable to parse the Dependabot configuration: ${errorMessage(error)}`)
    return []
  }

  if (!isRecord(config)) {
    return []
  }

  const entries: unknown[] = []
  if (Array.isArray(config.updates)) {
    entries.push(...config.updates)
  }
  if (isRecord(config['multi-ecosystem-groups'])) {
    entries.push(...Object.values(config['multi-ecosystem-groups']))
  }

  const branchPrefixes: BranchPrefix[] = []
  for (const entry of entries) {
    const branchNameConfig = isRecord(entry) ? entry['pull-request-branch-name'] : undefined
    if (!isRecord(branchNameConfig) || typeof branchNameConfig.prefix !== 'string') {
      continue
    }

    const separator = typeof branchNameConfig.separator === 'string' && branchNameConfig.separator.length === 1
      ? branchNameConfig.separator
      : DEFAULT_SEPARATOR
    const prefix = normalizeBranchPrefix(branchNameConfig.prefix, separator)

    if (prefix.length > 0) {
      branchPrefixes.push({ prefix, separator })
    }
  }

  return uniqueBranchPrefixes(branchPrefixes)
}

/**
 * Finds the longest branch prefix the branch name starts with, followed by its delimiter.
 * The default "dependabot" prefix is always considered.
 */
export function findBranchPrefix (branchName: string, branchPrefixes: BranchPrefix[] = []): BranchPrefixMatch | null {
  let match: BranchPrefixMatch | null = null

  for (const { prefix, separator } of [...branchPrefixes, DEFAULT_BRANCH_PREFIX]) {
    if (prefix.length === 0 || branchName.length <= prefix.length || !branchName.startsWith(prefix)) {
      continue
    }

    const delimiter = branchName[prefix.length]
    if (separator !== undefined && delimiter !== separator) {
      continue
    }

    if (!match || prefix.length > match.prefix.length) {
      match = { prefix, delimiter }
    }
  }

  return match
}

/**
 * Resolves the custom branch prefixes Dependabot may use for the repository.
 *
 * When the `branch-prefix` input is set, it takes precedence. Otherwise the prefixes are read from the Dependabot
 * configuration file on the default branch, which is where Dependabot reads it from. This never throws: when the
 * configuration file cannot be read, no custom prefix is returned and only the default "dependabot" prefix applies.
 */
export async function getBranchPrefixes (client: InstanceType<typeof GitHub>, context: Context, input = ''): Promise<BranchPrefix[]> {
  if (input.trim().length > 0) {
    const branchPrefixes = parseBranchPrefixInput(input)
    core.debug(`Using the branch prefixes from the \`branch-prefix\` input: ${formatBranchPrefixes(branchPrefixes)}`)
    return branchPrefixes
  }

  for (const path of DEPENDABOT_CONFIG_PATHS) {
    let configContent: string
    try {
      const { data } = await client.rest.repos.getContent({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path
      })

      if (Array.isArray(data) || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') {
        core.debug(`Ignoring ${path} as it is not a readable file`)
        continue
      }

      configContent = Buffer.from(data.content, 'base64').toString('utf8')
    } catch (error) {
      if (errorStatus(error) === 404) {
        core.debug(`${path} not found`)
        continue
      }

      core.info(`Unable to read ${path} to detect custom branch prefixes, falling back to the default "${DEFAULT_BRANCH_PREFIX.prefix}" prefix: ${errorMessage(error)}`)
      return []
    }

    const branchPrefixes = parseBranchPrefixConfig(configContent)
    if (branchPrefixes.length > 0) {
      core.info(`Found custom branch prefixes in ${path}: ${formatBranchPrefixes(branchPrefixes)}`)
    } else {
      core.debug(`No custom branch prefix configured in ${path}`)
    }
    return branchPrefixes
  }

  core.debug('No Dependabot configuration file found, falling back to the default branch prefix')
  return []
}

export function formatBranchPrefixes (branchPrefixes: BranchPrefix[]): string {
  return [...new Set(branchPrefixes.map(({ prefix }) => `"${prefix}"`))].join(', ')
}

function uniqueBranchPrefixes (branchPrefixes: BranchPrefix[]): BranchPrefix[] {
  const seen = new Set<string>()
  return branchPrefixes.filter(({ prefix, separator }) => {
    const key = `${prefix}\n${separator}`
    if (prefix.length === 0 || seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorStatus (error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === 'number' ? error.status : undefined
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
