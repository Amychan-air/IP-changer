const NetworkAdapter = require('./base');

class InterfacesAdapter extends NetworkAdapter {
  async applyStaticConfig(cfg) {
    const addrs = cfg.addresses || [cfg.address];

    // 生成新介面的配置區塊
    const newBlockLines = [
      '',
      `auto ${cfg.iface}`,
      `iface ${cfg.iface} inet static`,
      `    address ${addrs[0]}/${cfg.prefix}`
    ];

    // 如果 address 和 gateway 不同才添加 gateway，避免 RTNETLINK 錯誤
    if (cfg.gateway && cfg.gateway !== addrs[0]) {
      newBlockLines.push(`    gateway ${cfg.gateway}`);
      // 對於 /32 掩碼，有時需要手動指定路由
      if (cfg.prefix === 32 || cfg.prefix === '32') {
        newBlockLines.push(`    post-up ip route add ${cfg.gateway} dev ${cfg.iface} scope link || true`);
        newBlockLines.push(`    post-up ip route add default via ${cfg.gateway} dev ${cfg.iface} || true`);
      }
    }

    if (cfg.dns && cfg.dns.length && cfg.dns[0]) {
      newBlockLines.push(`    dns-nameservers ${cfg.dns.join(' ')}`);
    }

    // 新增別名 (Aliases)
    addrs.slice(1).forEach((addr, index) => {
      newBlockLines.push('');
      newBlockLines.push(`auto ${cfg.iface}:${index}`);
      newBlockLines.push(`iface ${cfg.iface}:${index} inet static`);
      newBlockLines.push(`    address ${addr}/${cfg.prefix}`);
    });

    const newBlock = newBlockLines.join('\n') + '\n';

    const file = '/etc/network/interfaces';

    // 讀取現有檔案
    const { stdout: currentContent } = await this.ssh.exec(this.hostId, `cat ${file}`);

    // 解析並移除該介面及其所有別名 (:0, :1 等) 的舊設定
    const lines = currentContent.split('\n');
    const newLines = [];
    let skipping = false;

    // 增強型匹配：處理不規則縮排
    const startRegex = new RegExp(`^\\s*(auto|iface|allow-hotplug)\\s+${cfg.iface}(:|\\s|$)`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (/^\s*(auto|iface|allow-hotplug|mapping|source)/.test(line)) {
        if (startRegex.test(line)) {
          skipping = true;
        } else {
          skipping = false;
        }
      }

      if (!skipping) {
        newLines.push(line);
      }
    }

    // 移除末尾多餘空行
    while (newLines.length > 0 && newLines[newLines.length - 1].trim() === '') {
      newLines.pop();
    }

    // 組合新內容
    const finalContent = newLines.join('\n').trim() + '\n' + newBlock;

    if (cfg.dryRun) {
      return `
# Modifying ${file}
# New config for ${cfg.iface}:
${newBlock}
# Using ifdown/ifup for surgical update:
ifdown ${cfg.iface} --force || true
ifup ${cfg.iface}
`;
    }

    const cmd = `cat <<'EOF' | tee ${file} > /dev/null
${finalContent}
EOF
ifdown ${cfg.iface} --force || true
ifup ${cfg.iface}`;

    const res = await this.ssh.exec(this.hostId, cmd);
    if (res.code !== 0) {
      throw new Error(`更新介面 ${cfg.iface} 失敗 (退出碼 ${res.code}): ${res.stderr}`);
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
    const file = '/etc/network/interfaces';
    
    // 讀取現有檔案
    const { stdout: currentContent } = await this.ssh.exec(this.hostId, `cat ${file}`);
    
    const lines = currentContent.split('\n');
    const newLines = [];
    let skipping = false;
    
    // 增強型匹配：處理不規則縮排，匹配該介面或其別名
    const startRegex = new RegExp(`^\\s*(auto|iface|allow-hotplug)\\s+${iface}(:|\\s|$)`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (/^\\s*(auto|iface|allow-hotplug|mapping|source)/.test(line)) {
        if (startRegex.test(line)) {
          skipping = true;
        } else {
          skipping = false;
        }
      }
      
      if (!skipping) {
        newLines.push(line);
      }
    }

    // 加入 DHCP 配置（作為清除靜態 IP 後的默認狀態）
    const dhcpBlock = [
        '',
        `auto ${iface}`,
        `iface ${iface} inet dhcp`,
        ''
    ].join('\n');

    // 組合
    while (newLines.length > 0 && newLines[newLines.length - 1].trim() === '') {
      newLines.pop();
    }
    const finalContent = newLines.join('\n').trim() + '\n' + dhcpBlock;

    const cmd = `cat <<'EOF' | tee ${file} > /dev/null
${finalContent}
EOF
ifdown ${iface} --force || true
ifup ${iface}`;

    await this.ssh.exec(this.hostId, cmd);
    return this.currentIPs();
  }
}

module.exports = InterfacesAdapter;

