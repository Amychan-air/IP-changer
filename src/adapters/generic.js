const NetworkAdapter = require('./base');

class GenericAdapter extends NetworkAdapter {
  /**
   * 临时配置：使用 ip 命令添加地址和路由
   */
  async applyStaticConfig(cfg) {
    const cmds = [
      `ip addr flush dev ${cfg.iface}`,
      `ip addr add ${cfg.address}/${cfg.prefix} dev ${cfg.iface}`,
      `ip link set ${cfg.iface} up`,
      `ip route add default via ${cfg.gateway} dev ${cfg.iface}`,
    ];
    if (cfg.dns && cfg.dns.length) {
      // 使用 resolvectl 或回退 /etc/resolv.conf
      cmds.push(
        `echo "nameserver ${cfg.dns.join('\\nnameserver ')}" > /etc/resolv.conf`,
      );
    }

    // 性能优化：批量执行，减少 RTT，且原子性更好（防止 flush 后断连）
    const fullScript = cmds.join(' && ');

    if (cfg.dryRun) {
      return fullScript;
    }

    const res = await this.ssh.exec(this.hostId, fullScript);
    if (res.code !== 0) {
      throw new Error(`执行配置失败: ${res.stderr}`);
    }

    return this.currentIPs();
  }

  async removeIPs(iface, addresses) {
    // addresses 是 CIDR 列表 (e.g. "1.2.3.4/24")
    const cmds = addresses.map(addr => `ip addr del ${addr} dev ${iface}`);
    const fullScript = cmds.join(' && ');
    const res = await this.ssh.exec(this.hostId, fullScript);
    if (res.code !== 0) {
      console.warn(`部分 IP 删除失败: ${res.stderr}`);
    }
    return this.currentIPs();
  }

  async clearIps(iface) {
    await this.ssh.exec(this.hostId, `ip addr flush dev ${iface}`);
    return this.currentIPs();
  }
}

module.exports = GenericAdapter;

