const { Client } = require('ssh2');
const EventEmitter = require('events');

class SSHManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map(); // hostId -> Client
    this.shells = new Map(); // hostId -> stream
    this.terminalOutputs = new Map(); // hostId -> onData callback
  }

  async connect(hostId, config) {
    if (this.connections.has(hostId)) {
      return this.connections.get(hostId);
    }

    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn
        .on('ready', () => {
          this.connections.set(hostId, conn);
          this.emit('ready', hostId);
          resolve(conn);
        })
        .on('error', (err) => {
          reject(err);
        })
        .on('end', () => {
          this.shells.delete(hostId);
          this.connections.delete(hostId);
          this.terminalOutputs.delete(hostId);
          this.emit('end', hostId);
        })
        .on('close', () => {
          this.shells.delete(hostId);
          this.connections.delete(hostId);
          this.terminalOutputs.delete(hostId);
          this.emit('close', hostId);
        });

      conn.connect({
        readyTimeout: 10000,
        tryKeyboard: false,
        ...config,
      });
    });
  }

  ensureConnection(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn) {
      throw new Error(`未找到 SSH 连接: ${hostId}`);
    }
    return conn;
  }

  /**
   * 注册终端输出回调，用于将 exec 命令的输出发送到终端
   * @param {string} hostId - 主机 ID
   * @param {function} onData - 数据回调函数 (data: string) => void
   */
  registerTerminalOutput(hostId, onData) {
    this.terminalOutputs.set(hostId, onData);
  }

  /**
   * 取消注册终端输出回调
   * @param {string} hostId - 主机 ID
   */
  unregisterTerminalOutput(hostId) {
    this.terminalOutputs.delete(hostId);
  }

  async exec(hostId, command, showInTerminal = true) {
    const conn = this.ensureConnection(hostId);
    const onTerminalData = this.terminalOutputs.get(hostId);
    
    // 如果需要在终端显示，先输出命令
    if (showInTerminal && onTerminalData) {
      onTerminalData(`\r\n\x1b[33m$ ${command}\x1b[0m\r\n`);
    }
    
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) {
          if (showInTerminal && onTerminalData) {
            onTerminalData(`\r\n\x1b[31m[执行错误] ${err.message}\x1b[0m\r\n`);
          }
          return reject(err);
        }
        let stdout = '';
        let stderr = '';
        stream
          .on('close', (code) => {
            // 将输出发送到终端
            if (showInTerminal && onTerminalData) {
              if (stderr) {
                onTerminalData(`\x1b[31m${stderr}\x1b[0m`);
              }
              if (code !== 0) {
                onTerminalData(`\r\n\x1b[31m[退出码: ${code}]\x1b[0m\r\n`);
              } else if (stdout || stderr) {
                // 如果有输出，添加换行以便后续命令显示更清晰
                onTerminalData('\r\n');
              }
            }
            resolve({ code, stdout, stderr });
          })
          .on('data', (data) => {
            const text = data.toString();
            stdout += text;
            // 实时输出到终端
            if (showInTerminal && onTerminalData) {
              onTerminalData(text);
            }
          })
          .stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            // 实时输出错误到终端
            if (showInTerminal && onTerminalData) {
              onTerminalData(`\x1b[31m${text}\x1b[0m`);
            }
          });
      });
    });
  }

  async startShell(hostId, onData, onClose) {
    if (this.shells.has(hostId)) {
      return this.shells.get(hostId);
    }

    const conn = this.ensureConnection(hostId);
    return new Promise((resolve, reject) => {
      conn.shell((err, stream) => {
        if (err) return reject(err);
        this.shells.set(hostId, stream);
        stream.on('data', (data) => onData?.(data.toString()));
        stream.on('close', () => {
          this.shells.delete(hostId);
          onClose?.();
        });
        resolve(stream);
      });
    });
  }

  writeShell(hostId, data) {
    const shell = this.shells.get(hostId);
    if (!shell) {
      throw new Error('Shell 未建立');
    }
    shell.write(data);
  }

  async getOsRelease(hostId) {
    const { stdout } = await this.exec(hostId, 'cat /etc/os-release', false);
    return stdout;
  }

  async listInterfaces(hostId) {
    try {
      const { stdout } = await this.exec(hostId, 'ip -o link show', false);
      const lines = stdout.trim().split('\n').filter(Boolean);
      return lines.map((line) => {
        // example: 2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> ...
        const parts = line.split(':');
        if (parts.length >= 2) {
          return parts[1].trim();
        }
        return null;
      }).filter(Boolean);
    } catch (e) {
      console.error('Error listing interfaces:', e);
      return [];
    }
  }

  async listAddresses(hostId) {
    const { stdout } = await this.exec(hostId, 'ip -o addr show', false);
    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      // example: 2: eth0    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0
      const parts = line.trim().split(/\s+/);
      const iface = parts[1];
      const family = parts[2];
      const address = parts[3];
      const scope = parts.includes('dynamic') ? 'dynamic' : 'static';
      return { iface, family, address, scope };
    });
  }

  async getGateways(hostId) {
    try {
      const { stdout } = await this.exec(hostId, 'ip route show default', false);
      // example output: 
      // default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.5 metric 100 
      // default via 10.0.0.1 dev eth1 
      const lines = stdout.trim().split('\n').filter(Boolean);
      const gateways = {};
      
      lines.forEach(line => {
        const parts = line.split(' ');
        const viaIndex = parts.indexOf('via');
        const devIndex = parts.indexOf('dev');
        
        if (viaIndex !== -1 && devIndex !== -1) {
          const gw = parts[viaIndex + 1];
          const iface = parts[devIndex + 1];
          gateways[iface] = gw;
        }
      });
      return gateways;
    } catch (e) {
      return {};
    }
  }

  close(hostId) {
    const shell = this.shells.get(hostId);
    if (shell) {
      shell.end();
      this.shells.delete(hostId);
    }
    const conn = this.connections.get(hostId);
    if (conn) {
      conn.end();
      this.connections.delete(hostId);
    }
    // 清理终端输出回调
    this.terminalOutputs.delete(hostId);
  }
}

module.exports = {
  SSHManager,
};

