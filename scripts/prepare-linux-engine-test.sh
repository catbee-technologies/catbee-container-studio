#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y uidmap iptables apparmor dbus-user-session xvfb xauth

# The Actions shell has no desktop login. Use the runner's systemd user bus
# so rootless runc can create a delegated scope when it starts a container.
runner_uid="$(id -u)"
sudo loginctl enable-linger "$(id -un)"
sudo systemctl start "user@${runner_uid}.service"
export XDG_RUNTIME_DIR="/run/user/$runner_uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user start dbus.service
# Check that the user manager answers over the same bus address runc will use.
# The manager can take a moment to register its name after the socket starts.
user_manager_ping=(busctl --address="$DBUS_SESSION_BUS_ADDRESS" --timeout=2s
  call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.DBus.Peer Ping)
for attempt in {1..10}; do
  if "${user_manager_ping[@]}" >/dev/null; then
    break
  fi
  if [[ "$attempt" == 10 ]]; then
    echo "The systemd user manager did not answer on $DBUS_SESSION_BUS_ADDRESS" >&2
    exit 1
  fi
  sleep 1
done
systemd-run --user --scope --quiet --property=Delegate=yes /usr/bin/true
printf 'XDG_RUNTIME_DIR=%s\nDBUS_SESSION_BUS_ADDRESS=%s\n' "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"

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
