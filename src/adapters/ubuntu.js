const yaml = require('js-yaml');
const NetworkAdapter = require('./base');

class NetplanAdapter extends NetworkAdapter {
  async applyStaticConfig(cfg) {
    const file = await this.resolveNetplanFile();
    const raw = await this.readFile(file);
    const doc = raw ? yaml.load(raw) || {} : {};

    doc.network = doc.network || {};
    doc.network.version = doc.network.version || 2;
    doc.network.renderer = doc.network.renderer || 'networkd';
    doc.network.ethernets = doc.network.ethernets || {};
    doc.network.ethernets[cfg.iface] = doc.network.ethernets[cfg.iface] || {};

    const block = doc.network.ethernets[cfg.iface];
    const newAddrs = (cfg.addresses || [cfg.address]).map((a) => `${a}/${cfg.prefix}`);
    const existingAddrs = Array.isArray(block.addresses) ? block.addresses : [];

    // 合并现有地址和新地址，并去重
    const combined = [...existingAddrs];
    for (const addr of newAddrs) {
      if (!combined.includes(addr)) {
        combined.push(addr);
      }
    }
    block.addresses = combined;
    
    // 使用新的 routes 语法替代已弃用的 gateway4
    delete block.gateway4;
    block.dhcp4 = false;

    if (cfg.gateway) {
      block.routes = block.routes || [];
      // 移除现有的默认路由以避免冲突
      block.routes = block.routes.filter((r) => r.to !== 'default');
      // 添加新的默认路由
      block.routes.push({
        to: 'default',
        via: cfg.gateway,
      });
    }

    if (cfg.dns && cfg.dns.length) {
      block.nameservers = { addresses: cfg.dns };
    }

    const rendered = yaml.dump(doc, { forceQuotes: false, lineWidth: 120 });
    
    if (cfg.dryRun) {
      return `cat <<'EOF' | tee ${file} > /dev/null
${rendered}
EOF
netplan apply`;
    }

    await this.writeFile(file, rendered);
    const res = await this.ssh.exec(this.hostId, 'netplan apply');
    if (res.code !== 0) {
      throw new Error(`netplan apply 失败: ${res.stderr}`);
    }
    return this.currentIPs();
  }

  async removeIPs(iface, addresses) {
    const file = await this.resolveNetplanFile();
    const raw = await this.readFile(file);
    const doc = raw ? yaml.load(raw) || {} : {};

    if (doc.network && doc.network.ethernets && doc.network.ethernets[iface]) {
      const block = doc.network.ethernets[iface];
      if (block.addresses && Array.isArray(block.addresses)) {
        // 过滤掉需要删除的 IP
        // addresses 参数是 CIDR 列表 (e.g. "1.2.3.4/24")
        // Netplan 文件中的 addresses 也通常是 CIDR
        // 这里进行简单字符串匹配，如果格式不一致可能需要更复杂的解析
        block.addresses = block.addresses.filter(addr => !addresses.includes(addr));
        
        const rendered = yaml.dump(doc, { forceQuotes: false, lineWidth: 120 });
        await this.writeFile(file, rendered);
        await this.ssh.exec(this.hostId, 'netplan apply');
      }
    }
    return this.currentIPs();
  }

  async clearIps(iface) {
    const file = await this.resolveNetplanFile();
    const raw = await this.readFile(file);
    const doc = raw ? yaml.load(raw) || {} : {};

    if (doc.network && doc.network.ethernets && doc.network.ethernets[iface]) {
      const block = doc.network.ethernets[iface];
      delete block.addresses;
      delete block.gateway4;
      delete block.routes;
      delete block.nameservers;
      block.dhcp4 = true;

      const rendered = yaml.dump(doc, { forceQuotes: false, lineWidth: 120 });
      await this.writeFile(file, rendered);
      await this.ssh.exec(this.hostId, 'netplan apply');
    }
    return this.currentIPs();
  }

  async resolveNetplanFile() {
    if (!this.ssh || !this.hostId) {
      return '/etc/netplan/01-netcfg.yaml';
    }
    const { stdout } = await this.ssh.exec(
      this.hostId,
      'ls /etc/netplan/*.yaml /etc/netplan/*.yml 2>/dev/null | head -n 1',
    );
    const file = stdout.trim();
    if (!file) {
      throw new Error('未找到 netplan 配置文件 (/etc/netplan/*.yaml)');
    }
    return file;
  }

  async readFile(file) {
    if (!this.ssh || !this.hostId) {
      return '';
    }
    const { stdout, code } = await this.ssh.exec(this.hostId, `cat ${file}`);
    if (code !== 0) return '';
    return stdout;
  }

  async writeFile(file, content) {
    if (!this.ssh || !this.hostId) {
      return;
    }
    // 使用 heredoc 安全写入
    const payload = `cat <<'EOF' | tee ${file} > /dev/null
${content}
EOF`;
    const { code, stderr } = await this.ssh.exec(this.hostId, payload);
    if (code !== 0) {
      throw new Error(`写入 netplan 失败: ${stderr}`);
    }
  }
}

module.exports = NetplanAdapter;

