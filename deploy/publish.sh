#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && "$1" =~ ^[a-f0-9]{40}$ ]] || { echo 'Usage: publish.sh FULL_COMMIT_SHA' >&2; exit 64; }
release=$1
: "${INFRA_SSH_HOST:?Missing Phase infrastructure host}"
: "${INFRA_SSH_KEY:?Missing Phase infrastructure SSH key}"
: "${INFRA_SSH_KNOWN_HOSTS:?Missing Phase pinned host key}"
[[ -s gains-release.tar.gz ]] || { echo 'Missing gains-release.tar.gz' >&2; exit 1; }
if [[ ${GITHUB_ACTIONS:-} == true ]]; then
  for value in "$INFRA_SSH_HOST" "$INFRA_SSH_KEY" "$INFRA_SSH_KNOWN_HOSTS"; do
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then
        line=${line//%/%25}
        printf '::add-mask::%s\n' "${line//$'\r'/%0D}"
      fi
    done <<< "$value"
  done
fi
umask 077
ssh_dir=$(mktemp -d)
trap 'rm -rf "$ssh_dir"' EXIT
printf '%s\n' "$INFRA_SSH_KEY" > "$ssh_dir/key"
printf '%s\n' "$INFRA_SSH_KNOWN_HOSTS" > "$ssh_dir/known_hosts"
options=(-i "$ssh_dir/key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$ssh_dir/known_hosts")
host="root@$INFRA_SSH_HOST"
ssh "${options[@]}" "$host" 'test -x /usr/local/sbin/gains-release && test -d /srv/apps/gains/incoming'
scp "${options[@]}" gains-release.tar.gz "$host:/srv/apps/gains/incoming/$release.tar.gz.part"
ssh "${options[@]}" "$host" "mv /srv/apps/gains/incoming/$release.tar.gz.part /srv/apps/gains/incoming/$release.tar.gz && /usr/local/sbin/gains-release $release"
curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 2 \
  --connect-timeout 10 --max-time 30 "${DEPLOY_URL:-https://gains.codictive.be}/health"
