const pullRequestMergeCommitRegex = /^Merge pull request #\d+ from \S+/
const branchMergeCommitRegex = /Merge (remote-tracking )?branch \S+( of https:\/\/github\.com\/\S+)? into \S+/
function isMergeCommitMessage (message) {
  return !!(message.match(pullRequestMergeCommitRegex) || message.match(branchMergeCommitRegex))
}

exports.isMergeCommitMessage = isMergeCommitMessage
