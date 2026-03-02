const { getInput, setOutput, setFailed, setSecret, debug, info, error, warning } = require('@actions/core')
const github = require('@actions/github')
const wso2 = require('byu-wso2-request')
const { DateTime } = require('luxon')
const { isMergeCommitMessage } = require('./utils.js')

const PRODUCTION_API_URL = 'https://api.byu.edu'
const SANDBOX_API_URL = 'https://api-sandbox.byu.edu'
const MIN_PLANNED_END_MINUTES = 1
const MAX_PLANNED_END_MINUTES = 10080
const REQUEST_TIMEOUT_MS = 10000
const MAX_RETRY_ATTEMPTS = 3
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504]
const IDEMPOTENT_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
let host = SANDBOX_API_URL

async function run () {
  const { context: { eventName } } = github
  if (!['push', 'schedule', 'workflow_dispatch'].includes(eventName)) {
    setFailed('Events other than `push`, `schedule`, and `workflow_dispatch` are not supported.')
    return
  }

  // Grab some inputs from GitHub Actions
  const clientKey = getInput('client-key')
  const clientSecret = getInput('client-secret')
  const templateId = getInput('template-id')
  const minutesUntilPlannedEndInput = getInput('minutes-until-planned-end')
  const minutesUntilPlannedEnd = validatePlannedEndMinutes(minutesUntilPlannedEndInput)
  const runInNonProduction = parseBooleanInput(getInput('run-in-non-production') || 'false')
  if (!clientKey || !clientSecret || !templateId) {
    setFailed('Missing a required input.')
    return
  }
  if (minutesUntilPlannedEnd === null) {
    setFailed(`Invalid input: minutes-until-planned-end must be an integer between ${MIN_PLANNED_END_MINUTES} and ${MAX_PLANNED_END_MINUTES}. Received "${minutesUntilPlannedEndInput}".`)
    return
  }
  setSecret(clientKey)
  setSecret(clientSecret)

  // Grab some info about the GitHub commits being pushed
  const payload = github.context.payload
  debug(`Action context: event=${eventName}, ref=${github.context.ref ?? payload.ref ?? 'unknown'}, runId=${github.context.runId}`)
  const githubUsername = payload.pusher?.name ?? payload.sender?.login ?? github.context.actor ?? 'github-actions[bot]'
  const numberOfCommits = payload.commits?.length ?? 0
  const repoName = payload.repository?.full_name ?? `${github.context.repo.owner}/${github.context.repo.repo}`
  const defaultBranch = payload.repository?.default_branch
  const currentBranch = getBranchNameFromRef(github.context.ref ?? payload.ref)
  const isDefaultBranch = (defaultBranch !== undefined && defaultBranch === currentBranch)
  const commitMessages = payload.commits?.map(commit => commit.message) ?? []
  const linkToCommits = payload.compare
  const deduplicatedFirstLinesOfCommitMessagesWithoutAnyMerges = [...new Set( // Deduplicate
    commitMessages
      .map(message => message.split('\n')[0]) // Get first line
      .filter(message => !isMergeCommitMessage(message)) // Filter out merge commits
  )]
  const runId = github.context.runId
  const linkToWorkflowRun = `https://github.com/${repoName}/actions/runs/${runId}`

  const shortDescription = (eventName === 'push' && numberOfCommits > 0)
    ? `${repoName}: ${deduplicatedFirstLinesOfCommitMessagesWithoutAnyMerges.join('; ')}`
    : `${repoName}: ${eventName === 'schedule' ? 'Automatic' : 'Manual'} redeploy`

  let description = `GitHub Actions workflow: ${linkToWorkflowRun}`
  if (eventName === 'push') {
    description += `\n${githubUsername} pushed ${numberOfCommits} ${numberOfCommits === 1 ? 'commit' : 'commits'}: ${linkToCommits}`
    if (numberOfCommits > 0) {
      description += `\n\nCommit messages:\n• ${commitMessages.join('\n• ')}`
    }
  }

  try {
    host = await resolveApiHost(clientKey, clientSecret)

    const servicenowHost = (host === PRODUCTION_API_URL) ? 'support.byu.edu' : 'support-test.byu.edu'

    if (host !== PRODUCTION_API_URL && !runInNonProduction) {
      const skipMessage = 'Skipping Standard Change RFC creation because this appears to be a non-production deployment. Set run-in-non-production to true if you want to create RFCs in sandbox.'
      if (isDefaultBranch) {
        warning(skipMessage)
      } else {
        debug(skipMessage)
      }
      setOutput('rfc-started', 'false')
      setOutput('rfc-number', '')
      setOutput('change-sys-id', '')
      setOutput('work-start', '')
      process.exit(0)
    }

    const alreadyCreatedRfc = await getRfcIfAlreadyCreated(linkToWorkflowRun).catch(() => {
      warning('An error occurred while trying to determine if an RFC was already created by a previous run of this workflow.')
      info('We will create a new RFC. If there was an existing RFC that failed, it will be your responsibility to update its status as appropriate.')
    })
    if (alreadyCreatedRfc) {
      warning('An existing RFC was found!')
      info(`RFC Number: ${alreadyCreatedRfc.number}
Link to RFC: https://${servicenowHost}/change_request.do?sysparm_query=number=${alreadyCreatedRfc.number}
Created on: ${alreadyCreatedRfc.sys_created_on}
Last updated on: ${alreadyCreatedRfc.sys_updated_on}`)
      // Set outputs for GitHub Actions
      setOutput('rfc-started', 'true')
      setOutput('rfc-number', alreadyCreatedRfc.number)
      setOutput('change-sys-id', alreadyCreatedRfc.sys_id)
      setOutput('work-start', alreadyCreatedRfc.work_start)
      process.exit(0)
    }

    const netId = await determineNetIdToAttributeRfc(githubUsername, templateId).catch(() => {
      error(`⚠ An error occurred while getting the Net ID associated with your GitHub username.
Is your GitHub username associated with your profile in ServiceNow?
You can check by going to https://${servicenowHost}/nav_to.do?uri=%2Fsys_user.do%3Fsys_id%3Djavascript:gs.getUserID()%26sysparm_view%3Dess`)
      process.exit(1)
    })

    // Start the RFC
    const optionsToStartRfc = {
      method: 'PUT',
      uri: `${host}/domains/servicenow/standardchange/v1/change_request`,
      body: {
        changes: [
          {
            assigned_to: netId,
            start_add_time: minutesUntilPlannedEnd, // Time in minutes from planned start time to planned end time
            short_description: (shortDescription.length > 160) ? `${shortDescription.slice(0, 157)}...` : shortDescription.slice(0, 160),
            description: description.slice(0, 4000),
            state: '20', // 10 = Draft, 20 = Submitted
            template_id: templateId
          }
        ]
      }
    }
    const bodyWithResultsOfStartingRfc = await requestWithRetry(optionsToStartRfc)
    const result = bodyWithResultsOfStartingRfc.result[0]
    if (!result.number) {
      error(`ServiceNow returned a 200, but didn't provide an RFC number.
Did you provide a valid template ID?
You can check by going to https://${servicenowHost}/nav_to.do?uri=%2Fu_standard_change_template_list.do`)
      process.exit(1)
    }

    info(`RFC Number: ${result.number}`)
    info(`Link to RFC: https://${servicenowHost}/change_request.do?sysparm_query=number=${result.number}`)

    // Set outputs for GitHub Actions
    setOutput('rfc-started', 'true')
    setOutput('rfc-number', result.number)
    setOutput('change-sys-id', result.change_sys_id)
    setOutput('work-start', convertServicenowTimestampFromMountainToUtc(result.workStart))
    process.exit(0) // Success! For some reason, without this, the action was hanging
  } catch (err) {
    setFailed(sanitizeErrorMessage(err?.message ?? String(err)))
    process.exit(1)
  }
}

async function requestWithRetry (options, retryOptions = {}) {
  const method = String(options.method ?? 'GET').toUpperCase()
  const requestOptions = { ...options, method }
  if (requestOptions.timeout === undefined) {
    requestOptions.timeout = REQUEST_TIMEOUT_MS
  }

  const maxAttempts = retryOptions.maxAttempts ?? MAX_RETRY_ATTEMPTS
  const shouldRetryUnsafeMethods = retryOptions.retryUnsafeMethods ?? false
  const canRetryMethod = shouldRetryUnsafeMethods || IDEMPOTENT_HTTP_METHODS.has(method)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await wso2.request(requestOptions)
    } catch (err) {
      const shouldRetry = canRetryMethod && attempt < maxAttempts && isRetryableError(err)
      if (!shouldRetry) {
        throw err
      }

      const delayMs = calculateRetryDelayMs(attempt)
      debug(`Retrying ${method} request in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`)
      await sleep(delayMs)
    }
  }
}

async function resolveApiHost (clientKey, clientSecret) {
  const hostsToTry = [SANDBOX_API_URL, PRODUCTION_API_URL]
  for (const candidateHost of hostsToTry) {
    try {
      await wso2.setOauthSettings(clientKey, clientSecret, { host: candidateHost })
      await requestWithRetry({
        method: 'GET',
        uri: `${candidateHost}/domains/servicenow/tableapi/v1/table/sys_user?sysparm_fields=sys_id&sysparm_limit=1`
      })
      return candidateHost
    } catch (e) {
      debug(`Could not authenticate against ${candidateHost}`)
    }
  }

  throw new Error('Unable to authenticate with BYU sandbox or production API hosts.')
}

function parseBooleanInput (inputValue) {
  const normalizedValue = String(inputValue).trim().toLowerCase()
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalizedValue)
}

function validatePlannedEndMinutes (inputValue) {
  const numericValue = Number(inputValue)
  if (!Number.isInteger(numericValue)) {
    return null
  }
  if (numericValue < MIN_PLANNED_END_MINUTES || numericValue > MAX_PLANNED_END_MINUTES) {
    return null
  }
  return numericValue
}

function getBranchNameFromRef (ref) {
  if (!ref) return ''
  return ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : ref
}

function isRetryableError (err) {
  const statusCode = err?.statusCode ?? err?.status
  if (typeof statusCode === 'number') {
    return RETRYABLE_STATUS_CODES.includes(statusCode)
  }
  return true
}

function calculateRetryDelayMs (attemptNumber) {
  const exponentialBackoffMs = 300 * (2 ** (attemptNumber - 1))
  const boundedBackoffMs = Math.min(exponentialBackoffMs, 5000)
  const jitterMs = Math.floor(Math.random() * 250)
  return boundedBackoffMs + jitterMs
}

function sleep (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function sanitizeErrorMessage (message) {
  return String(message)
    .replace(/[a-zA-Z0-9]{43}\.[a-zA-Z0-9]{43}/g, 'REDACTED')
    .replace(/Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi, 'Bearer REDACTED')
    .replace(/(client_secret=)[^&\s]+/gi, '$1REDACTED')
    .replace(/("client-secret"\s*:\s*")[^"]+(")/gi, '$1REDACTED$2')
}

async function getRfcIfAlreadyCreated (linkToWorkflowRun) {
  // linkToWorkflowRun includes the runId, which is stable between workflow re-runs
  // BTW, sequential scheduled runs aren't considered re-runs
  const tableName = 'change_request'
  const sysparmQuery = `type=standard^descriptionLIKE${linkToWorkflowRun}` // ^ corresponds to "and", LIKE corresponds to "contains"
  const options = {
    method: 'GET',
    uri: `${host}/domains/servicenow/tableapi/v1/table/${tableName}?sysparm_query=${sysparmQuery}`
  }
  const { result: [existingRfc] } = await requestWithRetry(options)
  return existingRfc
}

async function determineNetIdToAttributeRfc (githubUsername, templateId) {
  // If this is some automated change (e.g. on a schedule or from Dependabot)
  const isAutomation = (githubUsername === 'byu-oit-bot' || githubUsername === 'github-actions[bot]')
  const isDependabot = (githubUsername === 'dependabot[bot]' || githubUsername === 'dependabot-merge-action[bot]')
  if (isAutomation || isDependabot) {
    // If dependabot-fallback input is provided, attribute the change to that Net ID
    const dependabotFallback = getInput('dependabot-fallback')
    if (dependabotFallback !== '') {
      return dependabotFallback
    }

    // Otherwise, if an application-specific standard change template was specified (i.e., not the generic one baked into our template repos),
    // attribute the change to our GitHub Actions bot user in ServiceNow. A useful template is required so that Ops still knows who to contact
    // if something goes wrong with the change.
    const genericTemplateInUse = (templateId === 'Codepipeline-Standard-Change')
    if (!genericTemplateInUse) {
      return 'githubac'
    }

    warning(`This change appears to have been made by a robot. Ops needs to know who to contact if something goes wrong.
You have two options to fix this:
    1) Use a more specific standard change template.
    2) Blame a human for this change by providing a Net ID in the dependabot-fallback input.\n`)
  }

  return getNetIdAssociatedWithGithubUsernameInServicenow(githubUsername)
}

async function getNetIdAssociatedWithGithubUsernameInServicenow (githubUsername) {
  const optionsToGetNetId = {
    method: 'GET',
    uri: `${host}/domains/servicenow/tableapi/v1/table/sys_user?sysparm_query=u_github_username=${githubUsername}&sysparm_fields=user_name`
  }
  const { result: [{ user_name: netId }] } = await requestWithRetry(optionsToGetNetId)
  return netId
}

function convertServicenowTimestampFromMountainToUtc (timestamp) {
  return DateTime
    .fromFormat(timestamp, 'yyyy-LL-dd HH:mm:ss', { zone: 'America/Denver' })
    .toUTC().toFormat('yyyy-LL-dd HH:mm:ss')
}

run()
