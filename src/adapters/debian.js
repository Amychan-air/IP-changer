const NetworkAdapter = require('./base');

class InterfacesAdapter extends NetworkAdapter {
  async applyStaticConfig(cfg) {
    const addrs = cfg.addresses || [cfg.address];
    
    const content = [
      'auto lo',
      'iface lo inet loopback',
      '',
      `auto ${cfg.iface}`,
      `iface ${cfg.iface} inet static`,
      `    address ${addrs[0]}/${cfg.prefix}`,
      `    gateway ${cfg.gateway}`,
      ...(cfg.dns && cfg.dns.length ? [`    dns-nameservers ${cfg.dns.join(' ')}`] : []),
      '',
      ...addrs.map((addr, index) => [
        `auto ${cfg.iface}:${index}`,
        `iface ${cfg.iface}:${index} inet static`,
        `    address ${addr}/${cfg.prefix}`,
        ''
      ]).flat()
    ].join('\n');

    const file = '/etc/network/interfaces';
    const cmd = `cat <<'EOF' | tee ${file} > /dev/null
${content}
EOF
systemctl restart networking`;

    if (cfg.dryRun) {
      return cmd;
    }

    const res = await this.ssh.exec(this.hostId, cmd);
    if (res.code !== 0) {
      throw new Error(`写入 interfaces 失败: ${res.stderr}`);
    }
    return this.currentIPs();
  }

  async removeIPs(iface, addresses) {
    const file = '/etc/network/interfaces';
    const { stdout } = await this.ssh.exec(this.hostId, `cat ${file}`);
    
    const gatewayMatch = stdout.match(/gateway\s+(\S+)/);
    const dnsMatch = stdout.match(/dns-nameservers\s+(.+)/);
    const addressMatch = stdout.match(/address\s+(\S+)\/(\d+)/);
    
    const gateway = gatewayMatch ? gatewayMatch[1] : '';
    const dns = dnsMatch ? dnsMatch[1].split(/\s+/) : [];
    const prefix = addressMatch ? parseInt(addressMatch[2]) : 24;
    
    const existingAddresses = [];
    const addrRegex = /address\s+(\S+)\/\d+/g;
    let match;
    while ((match = addrRegex.exec(stdout)) !== null) {
      if (!existingAddresses.includes(match[1])) {
        existingAddresses.push(match[1]);
      }
    }
    
    const ipsToRemove = addresses.map(cidr => cidr.split('/')[0]);
    const remainingAddresses = existingAddresses.filter(addr => !ipsToRemove.includes(addr));
    
    if (remainingAddresses.length === 0) {
      return this.clearIps(iface);
    }
    
    return this.applyStaticConfig({
      iface,
      address: remainingAddresses[0],
      addresses: remainingAddresses,
      prefix,
      gateway,
      dns
    });
  }

  async clearIps(iface) {
    const content = [
      'auto lo',
      'iface lo inet loopback',
      '',
      `auto ${iface}`,
      `iface ${iface} inet dhcp`,
      '',
    ].join('\n');

    const file = '/etc/network/interfaces';
    const cmd = `cat <<'EOF' | tee ${file} > /dev/null
${content}
EOF
systemctl restart networking`;

    await this.ssh.exec(this.hostId, cmd);
    return this.currentIPs();
  }
}

module.exports = InterfacesAdapter;

