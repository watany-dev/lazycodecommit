#!/bin/sh
# Runs realcheck against a running AWS Emulator with every identity and CI input
# it can take: a second user, a logged-out SSO profile, and a CodeBuild project and
# a pipeline that have run once. No --limited-profile: the emulator lets a user
# without policies call CodeCommit, so the denial check cannot pass there.
# Usage: sh scripts/emulator/realcheck.sh [--port <port>] [realcheck options]
# Needs the AWS CLI. Passing here is not a real-AWS check (docs/dev/emulator.md).
set -eu
port=9297
if [ "${1:-}" = --port ]; then port=$2; shift 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
eval "$(sh "${root}/scripts/emulator/env.sh" "${port}")"
command -v aws >/dev/null || { echo "realcheck.sh: the AWS CLI is needed to set up users and CI" >&2; exit 1; }

dir="${TMPDIR:-/tmp}/lazycc-emulator-${port}"
creds="${dir}/credentials"
cp "${AWS_SHARED_CREDENTIALS_FILE}" "${creds}"

# One user per profile; a fresh key each run (a user holds at most two).
user() {
  aws iam get-user --user-name "$1" >/dev/null 2>&1 || aws iam create-user --user-name "$1" >/dev/null
  for old in $(aws iam list-access-keys --user-name "$1" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    aws iam delete-access-key --user-name "$1" --access-key-id "${old}"
  done
  set -- "$1" $(aws iam create-access-key --user-name "$1" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
  printf '\n[%s]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$1" "$2" "$3" >> "${creds}"
}
user rc-other
aws iam attach-user-policy --user-name rc-other --policy-arn arn:aws:iam::aws:policy/AWSCodeCommitPowerUser

# As after `aws sso logout`: a profile whose session has no cached token.
cat > "${dir}/config" <<EOF
[default]
region = us-east-1
[profile rc-sso]
sso_session = realcheck-emulator
sso_account_id = 000000000000
sso_role_name = Dev
region = us-east-1
[sso-session realcheck-emulator]
sso_start_url = https://realcheck-emulator.awsapps.com/start
sso_region = us-east-1
EOF
export AWS_SHARED_CREDENTIALS_FILE="${creds}" AWS_CONFIG_FILE="${dir}/config"

# CI to read: realcheck only reads builds and executions, so start one of each.
aws iam get-role --role-name rc-ci >/dev/null 2>&1 || aws iam create-role --role-name rc-ci \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":["codebuild.amazonaws.com","codepipeline.amazonaws.com"]},"Action":"sts:AssumeRole"}]}' >/dev/null
role=arn:aws:iam::000000000000:role/rc-ci
aws codebuild batch-get-projects --names rc-check --query 'projects[0].name' --output text | grep -q rc-check ||
  aws codebuild create-project --name rc-check --service-role "${role}" --artifacts type=NO_ARTIFACTS \
    --source type=CODECOMMIT,location=https://git-codecommit.us-east-1.amazonaws.com/v1/repos/rc-ci \
    --environment type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_SMALL >/dev/null
aws codebuild start-build --project-name rc-check --source-version refs/heads/main >/dev/null
aws codepipeline get-pipeline --name rc-release >/dev/null 2>&1 || aws codepipeline create-pipeline --pipeline "{
  \"name\": \"rc-release\", \"roleArn\": \"${role}\",
  \"artifactStore\": {\"type\": \"S3\", \"location\": \"rc-artifacts\"},
  \"stages\": [
    {\"name\": \"Source\", \"actions\": [{\"name\": \"Source\", \"outputArtifacts\": [{\"name\": \"src\"}],
      \"actionTypeId\": {\"category\": \"Source\", \"owner\": \"AWS\", \"provider\": \"CodeCommit\", \"version\": \"1\"},
      \"configuration\": {\"RepositoryName\": \"rc-ci\", \"BranchName\": \"main\", \"PollForSourceChanges\": \"false\"}}]},
    {\"name\": \"Build\", \"actions\": [{\"name\": \"Build\", \"inputArtifacts\": [{\"name\": \"src\"}],
      \"actionTypeId\": {\"category\": \"Build\", \"owner\": \"AWS\", \"provider\": \"CodeBuild\", \"version\": \"1\"},
      \"configuration\": {\"ProjectName\": \"rc-check\"}}]}]}" >/dev/null
aws codepipeline start-pipeline-execution --name rc-release >/dev/null

exec node "${root}/scripts/realcheck/realcheck.mjs" --emulator --region us-east-1 \
  --other-profile rc-other --sso-expired-profile rc-sso \
  --ci-project rc-check --ci-pipeline rc-release "$@"
