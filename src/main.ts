import * as core from '@actions/core'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Id, ILynqaClient, LynqaClient, RunStatus, Test, TestRunContext } from '@smartesting/lynqa-sdk'

const TEST_TIMEOUT = 1000 * 60 * 30

export async function run() {
  const client: ILynqaClient = new LynqaClient(
    core.getInput('lynqa-api-url', { required: true }),
    core.getInput('lynqa-api-key', { required: true })
  )

  const directory = core.getInput('directory', { required: true })
  const files = findJsonFiles(directory)
  if (files.length === 0) {
    core.setFailed(`No *.lynqa.json file found in ${directory}`)
    return
  }
  core.info(`Found ${files.length} files: ${files.join(', ')}`)

  let shouldStop = false
  let currentRunId: Id | null = null
  let currentLabel = ''

  const onStop = async (signal: NodeJS.Signals) => {
    shouldStop = true
    if (currentRunId) {
      core.info(`[${currentLabel}] Received ${signal}. Stopping test ${currentRunId}...`)
      try {
        await client.stopTestRuns!(currentRunId)
      } catch (e) {
        core.warning(`[${currentLabel}] Failed to stop: ${(e as Error).message}`)
      }
    }
  }
  process.on('SIGINT', onStop)
  process.on('SIGTERM', onStop)

  const failedTests: string[] = []

  try {
    for (const file of files) {
      if (shouldStop) break

      let content: any
      try {
        content = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (e) {
        core.error(`Error reading ${file}: ${(e as Error).message}`)
        continue
      }
      if (!Array.isArray(content.tests)) {
        core.warning(`No tests found in ${file}`)
        continue
      }

      for (let i = 0; i < content.tests.length; i++) {
        if (shouldStop) break

        const test: Test & { name: string } = content.tests[i]
        const label = `${path.basename(file)}#${i + 1}:${replacePlaceholders(test.name) ?? 'unnamed'}`

        try {
          const testRunId = await client.addTestRun({
            url: content.url,
            steps: test.steps.map(({ action, expectedResult }) => {
              return {
                action: replacePlaceholders(action),
                expectedResult: replacePlaceholders(expectedResult)
              }
            }),
            context: replacePlaceholdersInContext(test.context)
          })

          currentRunId = testRunId
          currentLabel = label

          core.info(`[${label}] [${new Date().toISOString()}] TestRun created: ${testRunId}`)

          try {
            const status = await waitForCompletion(client, testRunId, label, () => shouldStop)
            if (status !== RunStatus.SUCCESS) failedTests.push(label)
          } catch (e) {
            await client.stopTestRuns(testRunId)
            // noinspection ExceptionCaughtLocallyJS
            throw e
          }
        } catch (err) {
          core.error(`[${label}] Error occurred while test execution: ${(err as Error).message}`)
          failedTests.push(label)
        } finally {
          currentRunId = null
          currentLabel = ''
        }
      }
    }
  } finally {
    process.off('SIGINT', onStop)
    process.off('SIGTERM', onStop)
  }

  if (shouldStop) {
    core.setFailed('⚠️ Tests stopped by user')
    return
  }

  if (failedTests.length > 0) {
    core.setFailed(`❌ ${failedTests.length} test(s) failed: ${failedTests.join(', ')}`)
  } else {
    core.info('✅ All tests succeeded')
    process.exit(0)
  }
}

function findJsonFiles(dir: string): string[] {
  let files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files = files.concat(findJsonFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.lynqa.json')) {
      files.push(fullPath)
    }
  }
  return files
}

async function waitForCompletion(
  client: ILynqaClient,
  id: Id,
  label: string,
  shouldStop: () => boolean
): Promise<RunStatus> {
  const start = Date.now()

  while (Date.now() - start < TEST_TIMEOUT && !shouldStop()) {
    const { status, stepStatuses } = await client.getTestRunFullStatus(id)

    if ([RunStatus.RUNNING, RunStatus.WAITING].includes(status)) {
      const done = stepStatuses.filter((s) => s.end !== undefined).length
      core.info(`[${label}] [${new Date().toISOString()}] Status: ${status} (step ${done + 1}/${stepStatuses.length})`)
      await sleep(30000)
      continue
    }

    core.info(`[${label}] [${new Date().toISOString()}] Finished with status: ${status}`)
    return status
  }

  if (shouldStop()) {
    core.warning(`[${label}] Aborted by user`)
    return RunStatus.ERROR
  }

  core.warning(`[${label}] Timed out after 30 minutes`)
  return RunStatus.ERROR
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

function replacePlaceholders<S extends string | undefined>(str: S): S {
  if (typeof str !== 'string' || !str.length) return str

  return str.replace(/\{\{([^{}]+)}}/g, (match, inner) => {
    const trimmed = inner.trim()
    const m = /^(env|input)\.([A-Z0-9_]+)$/i.exec(trimmed)
    if (!m) return match

    const [, type, key] = m
    if (type.toLowerCase() === 'env' && process.env[key] !== undefined) {
      return process.env[key]!
    }
    if (type.toLowerCase() === 'input') {
      const val = core.getInput(key)
      if (val) return val
    }
    return match
  }) as S
}

function replacePlaceholdersInContext(context: TestRunContext | undefined) {
  if (!context) return context

  return {
    ...context,
    secrets: context.secrets?.map((s) => ({ ...s, value: replacePlaceholders(s.value) }))
  }
}
