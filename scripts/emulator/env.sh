#!/bin/sh
# Prints the environment that points lazycc (and git under it) at a running AWS
# Emulator. Usage: eval "$(sh scripts/emulator/env.sh [port])"
#
# The SDK and the AWS CLI go there through AWS_ENDPOINT_URL, which also covers
# profiles added to the credentials file (scripts/emulator/realcheck.sh adds one).
# git goes there through a git-remote-codecommit that dials the emulator, so a
# `lazycc clone --protocol grc` origin (codecommit::<region>://<repo>) stays one
# lazycc reads as CodeCommit; the emulator's own cloneUrlHttp
# (http://127.0.0.1:<another port>/...) is not.
set -eu
port=${1:-9297}
emu="${HOME}/.aws/emulator/${port}"
for f in config emulator_credentials ca.pem; do
  [ -f "${emu}/${f}" ] || { echo "env.sh: ${emu}/${f} is missing; is the emulator running on port ${port}?" >&2; exit 1; }
done
shim="${TMPDIR:-/tmp}/lazycc-emulator-${port}"
mkdir -p "${shim}/bin"
cat > "${shim}/bin/git-remote-codecommit" <<SHIM
#!/bin/sh
repo=\${2##*/}
GIT_SSL_CAINFO='${emu}/ca.pem' exec git remote-https "\$1" "https://127.0.0.1:${port}/v1/repos/\${repo##*@}"
SHIM
chmod +x "${shim}/bin/git-remote-codecommit"
key=$(sed -n 's/^aws_access_key_id *= *//p' "${emu}/emulator_credentials")
# The emulator reads only the user name of a git credential (the access key id,
# as `aws codecommit credential-helper` sends it).
cat > "${shim}/credential-helper" <<HELPER
#!/bin/sh
[ "\$1" = get ] && printf 'username=%s\npassword=emulator\n' "${key}"
exit 0
HELPER
chmod +x "${shim}/credential-helper"
cat <<ENV
export AWS_CONFIG_FILE='${emu}/config'
export AWS_SHARED_CREDENTIALS_FILE='${emu}/emulator_credentials'
export AWS_REGION=us-east-1
export AWS_ENDPOINT_URL='https://127.0.0.1:${port}'
export AWS_CA_BUNDLE='${emu}/ca.pem'
export NODE_EXTRA_CA_CERTS='${emu}/ca.pem'
export PATH='${shim}/bin':"\$PATH"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='credential.https://127.0.0.1:${port}.helper'
export GIT_CONFIG_VALUE_0='${shim}/credential-helper'
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
ENV
