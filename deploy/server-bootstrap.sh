#!/bin/bash
# One-time VPS bootstrap. Idempotent — safe to re-run.
#
# Usage:  scp deploy/server-bootstrap.sh root@<origin-ip>:/tmp/
#         ssh root@<origin-ip> 'bash /tmp/server-bootstrap.sh'
set -euo pipefail

# --- swap (1 GB VPS hits OOM without it) ---
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# --- docker + log rotation ---
# userland-proxy:false = pure iptables DNAT, no docker-proxy process per port.
if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sh
fi
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "userland-proxy": false
}
EOF
systemctl restart docker

# --- kernel tuning for UDP (pion + Caddy QUIC) ---
# Default rcvbuf 208 KiB drops RTP under burst.
cat > /etc/sysctl.d/99-voice-hub.conf <<'EOF'
net.core.rmem_max = 7340032
net.core.wmem_max = 7340032
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 5000
vm.swappiness = 10
EOF
sysctl --system

# --- non-root deploy user ---
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash -G docker deploy

# --- UFW: voice UDP + SSH (TCP 443 filtered separately via DOCKER-USER) ---
ufw allow 22/tcp
ufw allow 3478/udp comment "voice-hub stun/turn"
ufw allow 10101:10200/udp comment "voice-hub ICE"
ufw allow 49160:49199/udp comment "voice-hub TURN relay"
ufw --force enable

# --- SSH hardening ---
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh

# --- stack dir ---
mkdir -p /opt/voice-hub/deploy
chown -R deploy:deploy /opt/voice-hub

# --- Cloudflare-only TCP 443 (DOCKER-USER chain — UFW INPUT bypassed by docker) ---
cat > /usr/local/sbin/cf-firewall.sh <<'EOF'
#!/bin/bash
set -e
CF4=$(curl -fsS https://www.cloudflare.com/ips-v4)
CF6=$(curl -fsS https://www.cloudflare.com/ips-v6)
iptables  -F DOCKER-USER
ip6tables -F DOCKER-USER
iptables  -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
ip6tables -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for c in $CF4; do iptables  -A DOCKER-USER -p tcp --dport 443 -s "$c" -j RETURN; done
for c in $CF6; do ip6tables -A DOCKER-USER -p tcp --dport 443 -s "$c" -j RETURN; done
iptables  -A DOCKER-USER -p tcp --dport 443 -j DROP
ip6tables -A DOCKER-USER -p tcp --dport 443 -j DROP
EOF
chmod 700 /usr/local/sbin/cf-firewall.sh

cat > /etc/systemd/system/cf-firewall.service <<'EOF'
[Unit]
Description=Restrict origin TCP 443 to Cloudflare ranges
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cf-firewall.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now cf-firewall.service

# CF range list rarely changes but does — weekly auto-refresh.
echo '0 4 * * 0 root systemctl restart cf-firewall.service' > /etc/cron.d/cf-firewall-refresh
chmod 644 /etc/cron.d/cf-firewall-refresh

echo "bootstrap done."
