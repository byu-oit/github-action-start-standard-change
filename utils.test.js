const assert = require('node:assert')
const { isMergeCommitMessage } = require('./utils.js')

describe('isMergeCommitMessage', () => {
  describe('returns true for merge commits', () => {
    const mergeCommits = [
      'Merge branch dev into prd',
      'Merge branch \'idHash\' of https://github.com/byu-oit/ces-adm-sv-recommendations into idHash',
      'Merge remote-tracking branch \'origin/dev\' into jacobs27',
      'Merge pull request #1078 from byu-oit/dev'
    ]
    for (const message of mergeCommits) {
      test(message, () => {
        assert.equal(isMergeCommitMessage(message), true)
      })
    }
  })

  describe('returns false for non-merge commits', () => {
    const otherCommits = [
      'Add logging to subsystem A',
      'fix: typo on page B',
      'chore: update dependency C'
    ]
    for (const message of otherCommits) {
      test(message, () => {
        assert.equal(isMergeCommitMessage(message), false)
      })
    }
  })
})
