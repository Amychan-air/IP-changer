const NetworkAdapter = require('./base');

class CentOSAdapter extends NetworkAdapter {
  /**
   * 通过网卡名称查询 NetworkManager 连接名称
   * 因为连接名称可能和网卡名称不同（如 eth0 vs "Wired connection 1"）
   */
  async getConnectionName(iface) {
    if (!this.ssh || !this.hostId) {
      return iface;
    }
    try {
      // 使用 nmcli -t (tab-separated) 格式，更易解析
      // 格式: NAME:UUID:TYPE:DEVICE
      const { stdout } = await this.ssh.exec(
        this.hostId,
        `nmcli -t -f NAME,DEVICE con show | grep ":${iface}$" | head -1`
      );
      
      if (stdout.trim()) {
        // 提取连接名称（第一列，可能带引号）
        const match = stdout.trim().match(/^"([^"]+)"|^([^:]+)/);
        if (match) {
          return match[1] || match[2];
        }
      }
    } catch (err) {
      // 如果查询失败，继续尝试其他方法
    }

    // 后备方法: 尝试通过 nmcli dev status 查找
    try {
      const { stdout } = await this.ssh.exec(
        this.hostId,
        `nmcli -t -f CONNECTION,DEVICE dev status | grep ":${iface}$" | head -1`
      );
      if (stdout.trim()) {
        const match = stdout.trim().match(/^"([^"]+)"|^([^:]+)/);
        if (match && match[1] !== '--' && match[2] !== '--') {
          return match[1] || match[2];
        }
      }
    } catch (err) {
      // 继续后备
    }

    // 最后后备: 直接使用接口名称（某些系统连接名称就是接口名称）
    return iface;
  }

  /**
   * 使用 nmcli 设置静态 IP
   * cfg: { iface, address, prefix, gateway, dns: [], addresses: [] }
   */
  async applyStaticConfig(cfg) {
    // 先查询连接名称
    const connName = await this.getConnectionName(cfg.iface);
    
    const dnsList = cfg.dns && cfg.dns.length ? cfg.dns.join(' ') : null;
    const addresses = cfg.addresses || [cfg.address];
    
    const commands = [];
    
    // 全部使用 +ipv4.addresses 以实现增量添加，不覆盖现有 IP
    for (const addr of addresses) {
      commands.push(`nmcli con mod "${connName}" +ipv4.addresses ${addr}/${cfg.prefix}`);
    }
    
    // 设置网关、方法、自动连接
    commands.push(`nmcli con mod "${connName}" ipv4.gateway ${cfg.gateway}`);
    commands.push(`nmcli con mod "${connName}" ipv4.method manual`);
    commands.push(`nmcli con mod "${connName}" connection.autoconnect yes`);
    
    if (dnsList) {
      commands.push(`nmcli con mod "${connName}" ipv4.dns "${dnsList}"`);
    }
    
    // 最后激活连接
    commands.push(`nmcli con up "${connName}"`);

    // 性能优化：将所有命令拼接成一条脚本执行，减少网络往返
    // 使用 set -e 确保出错即停
    const fullScript = `
      set -e
      ${commands.join('\n')}
    `;

    if (cfg.dryRun) {
      return fullScript;
    }

    const res = await this.ssh.exec(this.hostId, fullScript);
    if (res.code !== 0) {
      throw new Error(`执行批量配置失败:\n${res.stderr}`);
    }
    
    return this.currentIPs();
  }

  async removeIPs(iface, addresses) {
    const connName = await this.getConnectionName(iface);
    // nmcli 使用 -ipv4.addresses 移除特定 IP
    const commands = addresses.map(addr => `nmcli con mod "${connName}" -ipv4.addresses ${addr}`);
    // 添加 con up 以应用更改
    commands.push(`nmcli con up "${connName}"`);
    
    const fullScript = `
      set -e
      ${commands.join('\n')}
    `;
    const res = await this.ssh.exec(this.hostId, fullScript);
    if (res.code !== 0) {
      throw new Error(`执行批量删除失败:\n${res.stderr}`);
    }
    return this.currentIPs();
  }

  async clearIps(iface) {
    const connName = await this.getConnectionName(iface);
    const commands = [
      `nmcli con mod "${connName}" ipv4.addresses ""`,
      `nmcli con mod "${connName}" ipv4.gateway ""`,
      `nmcli con mod "${connName}" ipv4.dns ""`,
      `nmcli con mod "${connName}" ipv4.method auto`,
      `nmcli con mod "${connName}" connection.autoconnect yes`,
      `nmcli con up "${connName}"`,
    ];
    
    // 性能优化：批量执行清除
    const fullScript = commands.join(' && ');
    const res = await this.ssh.exec(this.hostId, fullScript);
    
    if (res.code !== 0) {
      console.warn(`清除命令执行警告: ${res.stderr}`);
    }
    
    return this.currentIPs();
  }
}

module.exports = CentOSAdapter;

