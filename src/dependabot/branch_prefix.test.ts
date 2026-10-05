import * as github from '@actions/github'
import * as core from '@actions/core'
import nock from 'nock'
import { Context } from './github-context'
import {
  DEFAULT_BRANCH_PREFIX,
  findBranchPrefix,
  formatBranchPrefixes,
  getBranchPrefixes,
  normalizeBranchPrefix,
  parseBranchPrefixConfig
} from './branch_prefix'

const CONTENTS_PATH = '/repos/dependabot/dependabot/contents'
const YML_PATH = `${CONTENTS_PATH}/.github%2Fdependabot.yml`
const YAML_PATH = `${CONTENTS_PATH}/.github%2Fdependabot.yaml`

// Use fetch request settings to ensure nock mocks are respected
// @see https://github.com/actions/toolkit/issues/1115#issuecomment-1826196208
const mockGitHubClient = github.getOctokit('mock-token', { request: fetch })

function fileContent (content: string, encoding = 'base64') {
  return {
    type: 'file',
    encoding,
    name: 'dependabot.yml',
    path: '.github/dependabot.yml',
    content: encoding === 'base64' ? Buffer.from(content).toString('base64') : content
  }
}

beforeAll(() => {
  nock.disableNetConnect()
})

beforeEach(() => {
  jest.restoreAllMocks()

  jest.spyOn(core, 'debug').mockImplementation(jest.fn())
  jest.spyOn(core, 'info').mockImplementation(jest.fn())

  process.env.GITHUB_REPOSITORY = 'dependabot/dependabot'
})

afterEach(() => {
  nock.cleanAll()
})

describe('normalizeBranchPrefix', () => {
  test('it keeps a simple prefix as is', () => {
    expect(normalizeBranchPrefix('deps', '/')).toEqual('deps')
    expect(normalizeBranchPrefix('deps', '-')).toEqual('deps')
    expect(normalizeBranchPrefix('deps', '_')).toEqual('deps')
  })

  test('it replaces slashes with the separator', () => {
    expect(normalizeBranchPrefix('chore/deps', '/')).toEqual('chore/deps')
    expect(normalizeBranchPrefix('chore/deps', '-')).toEqual('chore-deps')
    expect(normalizeBranchPrefix('chore/deps', '_')).toEqual('chore_deps')
  })

  test('it sanitizes the prefix like Dependabot does', () => {
    expect(normalizeBranchPrefix(' my deps! ', '/')).toEqual('mydeps')
    expect(normalizeBranchPrefix('chore/.deps', '/')).toEqual('chore/dot-deps')
    expect(normalizeBranchPrefix('chore..deps', '/')).toEqual('chore.deps')
    expect(normalizeBranchPrefix('chore//deps', '-')).toEqual('chore-deps')
    expect(normalizeBranchPrefix('deps/', '/')).toEqual('deps')
    expect(normalizeBranchPrefix('deps(x){y}', '/')).toEqual('deps(x){y}')
    expect(normalizeBranchPrefix('', '/')).toEqual('')
  })
})

describe('parseBranchPrefixConfig', () => {
  test('it returns the prefixes configured in the updates', () => {
    const config = `
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: daily
    pull-request-branch-name:
      prefix: deps
  - package-ecosystem: docker
    directory: /
    schedule:
      interval: daily
    pull-request-branch-name:
      prefix: chore/deps
      separator: "-"
  - package-ecosystem: bundler
    directory: /
    schedule:
      interval: daily
    pull-request-branch-name:
      separator: "_"
  - package-ecosystem: pip
    directory: /
    schedule:
      interval: daily
`

    expect(parseBranchPrefixConfig(config)).toEqual([
      { prefix: 'deps', separator: '/' },
      { prefix: 'chore-deps', separator: '-' }
    ])
  })

  test('it returns the prefixes configured in the multi-ecosystem groups', () => {
    const config = `
version: 2
multi-ecosystem-groups:
  infrastructure:
    schedule:
      interval: weekly
    pull-request-branch-name:
      prefix: infra
      separator: "_"
updates:
  - package-ecosystem: docker
    directory: /
    patterns: ["*"]
    multi-ecosystem-group: infrastructure
`

    expect(parseBranchPrefixConfig(config)).toEqual([
      { prefix: 'infra', separator: '_' }
    ])
  })

  test('it removes duplicated prefixes', () => {
    const config = `
version: 2
updates:
  - package-ecosystem: npm
    pull-request-branch-name:
      prefix: deps
  - package-ecosystem: docker
    pull-request-branch-name:
      prefix: deps
      separator: /
`

    expect(parseBranchPrefixConfig(config)).toEqual([
      { prefix: 'deps', separator: '/' }
    ])
  })

  test('it supports YAML anchors, aliases and merge keys', () => {
    const config = `
version: 2
updates:
  - package-ecosystem: npm
    pull-request-branch-name: &branch
      prefix: deps
  - package-ecosystem: docker
    pull-request-branch-name:
      <<: *branch
      separator: "-"
  - package-ecosystem: pip
    pull-request-branch-name: *branch
`

    expect(parseBranchPrefixConfig(config)).toEqual([
      { prefix: 'deps', separator: '/' },
      { prefix: 'deps', separator: '-' }
    ])
  })

  test('it ignores invalid configurations', () => {
    expect(parseBranchPrefixConfig('')).toEqual([])
    expect(parseBranchPrefixConfig('version: 2\nupdates: [')).toEqual([])
    expect(parseBranchPrefixConfig('- not\n- a\n- map')).toEqual([])
    expect(parseBranchPrefixConfig('version: 2\nupdates: not-a-list')).toEqual([])
    expect(parseBranchPrefixConfig(`
version: 2
updates:
  - not-a-map
  - pull-request-branch-name: not-a-map
  - pull-request-branch-name:
      prefix: 42
  - pull-request-branch-name:
      prefix: "!!!"
  - pull-request-branch-name:
      prefix: deps
      separator: "--"
`)).toEqual([
      { prefix: 'deps', separator: '/' }
    ])
  })
})

describe('findBranchPrefix', () => {
  test('it matches the default prefix with any delimiter', () => {
    expect(findBranchPrefix('dependabot/npm_and_yarn/lodash-4.17.21')).toEqual({ prefix: 'dependabot', delimiter: '/' })
    expect(findBranchPrefix('dependabot-npm_and_yarn-lodash-4.17.21')).toEqual({ prefix: 'dependabot', delimiter: '-' })
    expect(findBranchPrefix('dependabot|nuget|feature1')).toEqual({ prefix: 'dependabot', delimiter: '|' })
  })

  test('it matches a custom prefix followed by its separator', () => {
    const branchPrefixes = [{ prefix: 'chore-deps', separator: '-' }]

    expect(findBranchPrefix('chore-deps-npm_and_yarn-lodash-4.17.21', branchPrefixes)).toEqual({ prefix: 'chore-deps', delimiter: '-' })
    expect(findBranchPrefix('dependabot/npm_and_yarn/lodash-4.17.21', branchPrefixes)).toEqual({ prefix: 'dependabot', delimiter: '/' })
  })

  test('it does not match a custom prefix followed by another separator', () => {
    expect(findBranchPrefix('deps-npm_and_yarn-lodash-4.17.21', [{ prefix: 'deps', separator: '/' }])).toBeNull()
    expect(findBranchPrefix('dep/npm_and_yarn/lodash-4.17.21', [{ prefix: 'de', separator: '/' }])).toBeNull()
  })

  test('it prefers the longest matching prefix', () => {
    const branchPrefixes = [{ prefix: 'dependabot-deps', separator: '/' }]

    expect(findBranchPrefix('dependabot-deps/npm_and_yarn/lodash-4.17.21', branchPrefixes)).toEqual({ prefix: 'dependabot-deps', delimiter: '/' })
  })

  test('it does not match a branch without a delimiter after the prefix', () => {
    expect(findBranchPrefix('dependabot')).toBeNull()
    expect(findBranchPrefix('deps', [{ prefix: 'deps', separator: '/' }])).toBeNull()
  })

  test('it does not match unknown prefixes', () => {
    expect(findBranchPrefix('renovate/lodash-4.x', [{ prefix: 'deps', separator: '/' }])).toBeNull()
    expect(findBranchPrefix('feature/dependabot/npm_and_yarn/lodash-4.17.21')).toBeNull()
  })

  test('it ignores empty prefixes', () => {
    expect(findBranchPrefix('/npm_and_yarn/lodash-4.17.21', [{ prefix: '', separator: '/' }])).toBeNull()
  })
})

describe('formatBranchPrefixes', () => {
  test('it lists the unique prefixes', () => {
    expect(formatBranchPrefixes([
      { prefix: 'deps', separator: '/' },
      { prefix: 'deps', separator: '-' },
      DEFAULT_BRANCH_PREFIX
    ])).toEqual('"deps", "dependabot"')
  })
})

describe('getBranchPrefixes', () => {
  test('it reads the prefixes from .github/dependabot.yml', async () => {
    const config = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    pull-request-branch-name:\n      prefix: chore/deps\n'
    const scope = nock('https://api.github.com').get(YML_PATH).reply(200, fileContent(config))

    expect(await getBranchPrefixes(mockGitHubClient, new Context())).toEqual([{ prefix: 'chore/deps', separator: '/' }])
    expect(scope.isDone()).toBe(true)
    expect(core.info).toHaveBeenCalledWith('Found custom branch prefixes in .github/dependabot.yml: "chore/deps"')
  })

  test('it falls back to .github/dependabot.yaml', async () => {
    const config = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    pull-request-branch-name:\n      prefix: deps\n'
    const scope = nock('https://api.github.com')
      .get(YML_PATH).reply(404, { message: 'Not Found' })
      .get(YAML_PATH).reply(200, fileContent(config))

    expect(await getBranchPrefixes(mockGitHubClient, new Context())).toEqual([{ prefix: 'deps', separator: '/' }])
    expect(scope.isDone()).toBe(true)
  })

  test('it returns no prefix when there is no custom prefix configured', async () => {
    const scope = nock('https://api.github.com').get(YML_PATH).reply(200, fileContent('version: 2\nupdates: []\n'))

    expect(await getBranchPrefixes(mockGitHubClient, new Context())).toEqual([])
    expect(scope.isDone()).toBe(true)
  })

  test('it returns no prefix when there is no Dependabot configuration', async () => {
    const scope = nock('https://api.github.com')
      .get(YML_PATH).reply(404, { message: 'Not Found' })
      .get(YAML_PATH).reply(404, { message: 'Not Found' })

    expect(await getBranchPrefixes(mockGitHubClient, new Context())).toEqual([])
    expect(scope.isDone()).toBe(true)
    expect(core.info).not.toHaveBeenCalled()
  })

  test('it ignores Dependabot configuration paths that are not readable files', async () => {
    const scope = nock('https://api.github.com')
      .get(YML_PATH).reply(200, [])
      .get(YAML_PATH).reply(200, fileContent('', 'none'))

    expect(await getBranchPrefixes(mockGitHubClient, new Context())).toEqual([])
    expect(scope.isDone()).toBe(true)
  })

  test('it returns no prefix when the Dependabot configuration cannot be read', async () => {
    const scope = nock('https://api.github.com')
      .get(YML_PATH).reply(403, { message: 'Resource not accessible by integration' })

    expect(await getBranchPrefixes(mockGitHubClient, new Context())).toEqual([])
    expect(scope.isDone()).toBe(true)
    expect(core.info).toHaveBeenCalledTimes(1)
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Unable to read .github/dependabot.yml'))
  })
})
