const { getInput, setOutput, setFailed, debug, error, warning } = require('@actions/core')
const github = require('@actions/github')
const wso2 = require('byu-wso2-request')
const { DateTime } = require('luxon')

const PRODUCTION_API_URL = 'https://api.byu.edu'
const SANDBOX_API_URL = 'https://api-sandbox.byu.edu'
let host = SANDBOX_API_URL

async function run () {
  const { context: { eventName } } = github
  if (eventName !== 'push') {
    setFailed('Events other than `push` are not supported.')
    return
  }

  // Grab some inputs from GitHub Actions
  const clientKey = getInput('client-key')
  const clientSecret = getInput('client-secret')
  const templateId = getInput('template-id')
  const minutesUntilPlannedEnd = parseInt(getInput('minutes-until-planned-end'), 10)
  if (!clientKey || !clientSecret || !templateId) {
    setFailed('Missing a required input')
    return
  }

  // Grab some info about the GitHub commits being pushed
  const payload = github.context.payload
  debug(`The event payload: ${JSON.stringify(payload, undefined, 2)}`)
  const githubUsername = payload.pusher.name
  const numberOfCommits = payload.commits.length
  const repoName = payload.repository.full_name
  const commitMessages = payload.commits.map(commit => commit.message)
  const linkToCommits = payload.compare
  const firstLinesOfCommitMessages = commitMessages.map(message => message.split('\n')[0])
  const runId = github.context.runId
  const linkToWorkflowRun = `https://github.com/${repoName}/actions/runs/${runId}`

  const shortDescription = `${githubUsername} pushed ${numberOfCommits} ${numberOfCommits > 1 ? 'commits' : 'commit'} to ${repoName}: ${firstLinesOfCommitMessages.join('; ')}`
  const description = `Link to workflow run: ${linkToWorkflowRun}\nLink to commits: ${linkToCommits}\n\nCommit Messages:\n---------------\n${commitMessages.join('\n\n')}`

  try {
    // Some setup required to make calls through Tyk
    // We don't know if creds passed in for sandbox or production. Trying sandbox first.
    try {
      await wso2.setOauthSettings(clientKey, clientSecret, { host })
      await requestWithRetry({ url: `${host}/echo/v1/echo/test`, simple: true })
    } catch (e) {
      host = PRODUCTION_API_URL
      await wso2.setOauthSettings(clientKey, clientSecret, { host })
      await requestWithRetry({ url: `${host}/echo/v1/echo/test`, simple: true })
    }

    const servicenowHost = (host === PRODUCTION_API_URL) ? 'support.byu.edu' : 'support-test.byu.edu'

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

    const netId = await getNetIdAssociatedWithGithubUsernameInServicenow(githubUsername).catch(() => {
      const isDependabot = (payload.pusher.name === 'dependabot[bot]' || payload.pusher.name === 'dependabot-merge-action[bot]')
      if (isDependabot) {
        const dependabotFallback = getInput('dependabot-fallback')
        if (dependabotFallback !== '') {
          return dependabotFallback
        } else {
          warning(`Could not get dependabot-fallback input. This action will fail.
If you want Dependabot auto-merges to succeed, use that input to define a GitHub username to attach Dependabot changes to.\n`)
        }
      }

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
  const tableName = 'change_request'
  const sysparmQuery = `type=standard^descriptionLIKE${linkToWorkflowRun}` // ^ corresponds to "and", LIKE corresponds to "contains"
  const options = {
    method: 'GET',
    uri: `${host}/domains/servicenow/tableapi/v1/table/${tableName}?sysparm_query=${sysparmQuery}`
  }
  const { result: [existingRfc] } = await requestWithRetry(options)
  return existingRfc
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
