#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y uidmap iptables apparmor xvfb xauth
for database in subuid subgid; do
  if ! awk -F: -v user="$(id -un)" '$1 == user && $3 >= 65536 { found = 1 } END { exit !found }' "/etc/$database"; then
    sudo usermod "--add-${database}s" 1000000-1065535 "$(id -un)"
  fi
done
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1

profile="$(mktemp)"
cat > "$profile" <<EOF
abi <abi/4.0>,
include <tunables/global>
"$HOME/.catbee/bin/rootlesskit" flags=(unconfined) {
  userns,
}
EOF
sudo apparmor_parser -r "$profile"
echo "CATBEE_TEST_APPARMOR_PROFILE=$profile" >> "$GITHUB_ENV"
