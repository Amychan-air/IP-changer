class NetworkAdapter {
  constructor(sshManager, hostId) {
    this.ssh = sshManager;
    this.hostId = hostId;
  }

  async applyStaticConfig() {
    throw new Error('applyStaticConfig 未实现');
  }

  async removeIPs(iface, addresses) {
    throw new Error('removeIPs 未实现');
  }

  async clearIps(iface) {
    throw new Error('clearIps 未实现');
  }

  async currentIPs() {
    return this.ssh.listAddresses(this.hostId);
  }
}

module.exports = NetworkAdapter;

