const { getInput, setOutput, setFailed, debug, error, warning } = require('@actions/core')
const github = require('@actions/github')
const wso2 = require('byu-wso2-request')
const { DateTime } = require('luxon')
const { isMergeCommitMessage } = require('./utils.js')

const PRODUCTION_API_URL = 'https://api.byu.edu'
const SANDBOX_API_URL = 'https://api-sandbox.byu.edu'
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
  let appEnv = getInput('app-env')
  const minutesUntilPlannedEnd = parseInt(getInput('minutes-until-planned-end'), 10)
  if (!clientKey || !clientSecret || !templateId) {
    setFailed('Missing a required input.')
    return
  }

  if (!appEnv) {
    warning('Application environment defaulting to dev.')
    appEnv = 'dev'
  }

  // Grab some info about the GitHub commits being pushed
  const payload = github.context.payload
  debug(`The event payload: ${JSON.stringify(payload, undefined, 2)}`)
  const githubUsername = payload.pusher?.name ?? payload.sender.login
  const numberOfCommits = payload.commits?.length ?? 0
  const repoName = payload.repository.full_name
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
    // Some setup required to make calls through Tyk
    // We don't know if creds passed in for sandbox or production. Trying sandbox first.
    if (appEnv === 'prd' || appEnv === 'production') {
      try {
        host = PRODUCTION_API_URL
        await wso2.setOauthSettings(clientKey, clientSecret, { host })
        await requestWithRetry({ url: `${host}/echo/v1/echo/test`, simple: true })
      } catch (e) {
        setFailed('Error while checking production ServiceNow credentials.')
        console.log('Auth credentials calls failed. Check OAuth credentials and/or application environment.')
      }
    } else {
      try {
        await wso2.setOauthSettings(clientKey, clientSecret, { host })
        await requestWithRetry({ url: `${host}/echo/v1/echo/test`, simple: true })
      } catch (e) {
        warning('Error while checking dev ServiceNow credentials')
        console.log('Auth credentials calls failed. Check OAuth credentials and/or application environment.')
      }
    }

    const servicenowHost = (appEnv === 'prd' || appEnv === 'production') ? 'support.byu.edu' : 'support-test.byu.edu'

    const alreadyCreatedRfc = await getRfcIfAlreadyCreated(linkToWorkflowRun).catch(() => {
      warning('An error occurred while trying to determine if an RFC was already created by a previous run of this workflow.')
      console.log('We will create a new RFC. If there was an existing RFC that failed, it will be your responsibility to update its status as appropriate.\n')
    })
    if (alreadyCreatedRfc) {
      warning('An existing RFC was found!')
      console.log(`RFC Number: ${alreadyCreatedRfc.number}
Link to RFC: https://${servicenowHost}/change_request.do?sysparm_query=number=${alreadyCreatedRfc.number}
Created on: ${alreadyCreatedRfc.sys_created_on}
Last updated on: ${alreadyCreatedRfc.sys_updated_on}`)
      // Set outputs for GitHub Actions
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

    console.log(`RFC Number: ${result.number}`)
    console.log(`Link to RFC: https://${servicenowHost}/change_request.do?sysparm_query=number=${result.number}`)

    // Set outputs for GitHub Actions
    setOutput('change-sys-id', result.change_sys_id)
    setOutput('work-start', convertServicenowTimestampFromMountainToUtc(result.workStart))
    process.exit(0) // Success! For some reason, without this, the action was hanging
  } catch (err) {
    const hydraTokenRegex = /[a-zA-Z0-9]{43}.[a-zA-Z0-9]{43}/g
    setFailed(err.message.replace(hydraTokenRegex, 'REDACTED'))
    process.exit(1)
  }
}

function requestWithRetry (options) {
  return wso2.request(options).catch(() => wso2.request(options))
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
