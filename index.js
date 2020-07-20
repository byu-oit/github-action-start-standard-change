const { getInput, setOutput, setFailed, debug, error } = require('@actions/core')
const github = require('@actions/github')
const wso2 = require('byu-wso2-request')
const jsonWebToken = require('jsonwebtoken')

async function run () {
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

  const shortDescription = `${githubUsername} pushed ${numberOfCommits} commit(s) to ${repoName}: ${firstLinesOfCommitMessages.join('; ')}`
  const description = `Link to commits: ${linkToCommits}\n\nCommit Messages:\n---------------\n${commitMessages.join('\n\n')}`

  try {
    // Some setup required to make calls through WSO2
    await wso2.setOauthSettings(clientKey, clientSecret)

    const netId = await getNetIdAssociatedWithGithubUsernameInServicenow(githubUsername).catch(() => {
      error(`⚠ An error occurred while getting the Net ID associated with your GitHub username.
Is your GitHub username associated with your profile in ServiceNow?
You can check by going to https://support.byu.edu/nav_to.do?uri=%2Fsys_user.do%3Fsys_id%3Djavascript:gs.getUserID()%26sysparm_view%3Dess`)
      process.exit(1)
    })

    // Start the RFC (and figure out if we're doing it in sandbox or production)
    const optionsToStartRfc = {
      method: 'PUT',
      uri: 'https://api.byu.edu:443/domains/servicenow/standardchange/v1/change_request',
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
    let errorOccurredWhileGettingCredentialsType = false
    const [bodyWithResultsOfStartingRfc, credentialsType] = await Promise.all([
      requestWithRetry(optionsToStartRfc),
      getTypeOfCredentials().catch(() => { errorOccurredWhileGettingCredentialsType = true; return 'PRODUCTION' })
    ])
    if (errorOccurredWhileGettingCredentialsType) {
      console.log('⚠️ An error occurred while trying to determine if production or sandbox credentials were used for ServiceNow. ⚠️')
      console.log('The standard change was still started in the correct environment.')
      console.log('So the link provided below will be for the production environment, even though you may have used sandbox credentials. 🤷')
    }
    const result = bodyWithResultsOfStartingRfc.result[0]
    if (!result.number) {
      setFailed('ServiceNow returned a 200, but didn\'t provide an RFC number. Did you provide a valid template ID?')
      process.exit(1)
    }

    console.log(`RFC Number: ${result.number}`)
    console.log(`Link to RFC: https://${credentialsType === 'PRODUCTION' ? 'support' : 'support-test'}.byu.edu/change_request.do?sysparm_query=number=${result.number}`)

    // Set outputs for GitHub Actions
    setOutput('change-sys-id', result.change_sys_id)
    setOutput('work-start', result.workStart)
    process.exit(0) // Success! For some reason, without this, the action was hanging
  } catch (err) {
    const wso2TokenRegex = /[0-9a-f]{32}/g
    setFailed(err.message.replace(wso2TokenRegex, 'REDACTED'))
    process.exit(1)
  }
}

function requestWithRetry (options) {
  return wso2.request(options).catch(() => wso2.request(options))
}

async function getTypeOfCredentials () {
  const options = { uri: 'https://api.byu.edu:443/echo/v1/echo/test', simple: true }
  const { Headers: { 'X-Jwt-Assertion': [jwt] } } = await requestWithRetry(options)
  const decoded = jsonWebToken.decode(jwt)
  return decoded['http://wso2.org/claims/keytype'] // 'PRODUCTION' | 'SANDBOX'
}

async function getNetIdAssociatedWithGithubUsernameInServicenow (githubUsername) {
  const optionsToGetNetId = {
    method: 'GET',
    uri: `https://api.byu.edu:443/domains/servicenow/tableapi/v1/table/sys_user?sysparm_query=u_github_username=${githubUsername}&sysparm_fields=user_name`
  }
  const { result: [{ user_name: netId }] } = await requestWithRetry(optionsToGetNetId)
  return netId
}

run()
