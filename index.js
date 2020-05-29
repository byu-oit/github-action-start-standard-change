const { getInput, setOutput, setFailed, debug } = require('@actions/core')
const github = require('@actions/github')
const wso2 = require('byu-wso2-request')

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

    // Translate GitHub username into Net ID
    const optionsToGetNetId = {
      method: 'GET',
      uri: `https://api.byu.edu:443/domains/servicenow/tableapi/v1/table/sys_user?sysparm_query=u_github_username=${githubUsername}&sysparm_fields=user_name`
    }
    const bodyWithNetId = await wso2.request(optionsToGetNetId).catch(() => wso2.request(optionsToGetNetId)) // Retry once
    const netId = bodyWithNetId.result[0].user_name

    // Start the RFC
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
    const bodyWithResultsOfStartingRfc = await wso2.request(optionsToStartRfc).catch(() => wso2.request(optionsToStartRfc)) // Retry once
    const result = bodyWithResultsOfStartingRfc.result[0]

    console.log(`RFC Number: ${result.number}`)
    console.log(`Link to RFC: https://it.byu.edu/change_request.do?sysparm_query=number=${result.number}`)

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

run()
