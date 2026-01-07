const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { SSHManager } = require('./ssh/client');
const { parseIpInput } = require('./utils/ip-calculator');
const { fromOsRelease, fromName } = require('./adapters');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sshManager = new SSHManager();
const hosts = new Map(); // id -> { id, host, port, username, adapter?, osRelease?, manualMode? }

function sanitizeHost(host) {
  const { id, host: h, port, username, osRelease, adapterName, manualMode } = host;
  return { id, host: h, port, username, osRelease, adapter: adapterName, manualMode };
}

async function ensureAdapter(hostId, manualMode = null) {
  const meta = hosts.get(hostId);
  if (!meta) {
    throw new Error('未找到主机');
  }

  if (manualMode) {
    const adapter = fromName(manualMode, sshManager, hostId);
    meta.adapter = adapter;
    meta.adapterName = adapter.constructor.name;
    meta.manualMode = manualMode;
    hosts.set(hostId, meta);
    return adapter;
  }

  if (meta.adapter && !meta.manualMode) return meta.adapter;

  const osRelease = await sshManager.getOsRelease(hostId);
  const adapter = fromOsRelease(osRelease, sshManager, hostId);
  meta.adapter = adapter;
  meta.osRelease = osRelease;
  meta.adapterName = adapter.constructor.name;
  hosts.set(hostId, meta);
  return adapter;
}

app.get('/api/health', (_, res) => {
  res.json({ ok: true });
});

app.get('/api/hosts', (_, res) => {
  res.json([...hosts.values()].map(sanitizeHost));
});

app.post('/api/hosts', async (req, res) => {
  const { id, host, port = 22, username, password, privateKey, manualMode } = req.body || {};
  if (!host || !username || (!password && !privateKey)) {
    return res.status(400).json({ error: 'host, username, password/privateKey 必填' });
  }
  const hostId = id || `${host}-${Date.now()}`;
  try {
    await sshManager.connect(hostId, { host, port, username, password, privateKey });
    hosts.set(hostId, { id: hostId, host, port, username, manualMode });

    // 立即获取 OS 信息和 IP 列表
    const osRelease = await sshManager.getOsRelease(hostId);
    const [ips, gateways] = await Promise.all([
      sshManager.listAddresses(hostId),
      sshManager.getGateways(hostId)
    ]);
    
    await ensureAdapter(hostId, manualMode);

    return res.json({ 
      id: hostId, 
      osRelease, 
      ips: { list: ips, gateways }, // 統一格式
      detectedAdapter: hosts.get(hostId).adapterName 
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/hosts/:id/ips', async (req, res) => {
  try {
    const { id } = req.params;
    if (!hosts.has(id)) return res.status(404).json({ error: '未找到主机' });
    
    // 平行執行兩個命令以提高效率
    const [list, gateways] = await Promise.all([
      sshManager.listAddresses(id),
      sshManager.getGateways(id)
    ]);
    
    res.json({ list, gateways });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ip-calc', (req, res) => {
  try {
    const result = parseIpInput(req.body.input);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/dry-run-generate', async (req, res) => {
  const { input, iface = 'eth0', dns = [], prefix, manualMode, applyAll, addresses: directAddresses, gateway: manualGateway } = req.body || {};
  
  if (!manualMode) {
    return res.status(400).json({ error: 'Generate command requires selecting a Config Mode' });
  }

  try {
    let prefixLen = prefix;
    let targetAddress;
    let allAddresses;
    let gateway = manualGateway;

    if (directAddresses && Array.isArray(directAddresses) && directAddresses.length > 0) {
      allAddresses = applyAll ? directAddresses : [directAddresses[0]];
      targetAddress = directAddresses[0];
      if (!prefixLen) {
        return res.status(400).json({ error: 'Prefix is required' });
      }
      if (!gateway) {
        const ip = require('ip');
        const firstLong = ip.toLong(targetAddress);
        gateway = ip.fromLong(firstLong - 1);
      }
    } else if (input) {
      const parsed = parseIpInput(input);
      if (parsed.mode === 'cidr') {
        prefixLen = Number(parsed.cidr.split('/')[1]);
      }
      if (!prefixLen) {
        return res.status(400).json({ error: 'Prefix is required' });
      }
      if (!parsed.hosts.length) {
        return res.status(400).json({ error: 'No available addresses' });
      }
      targetAddress = parsed.hosts[0];
      allAddresses = applyAll ? parsed.hosts : [targetAddress];
      if (!gateway) gateway = parsed.gateway;
    } else {
      return res.status(400).json({ error: 'Input or addresses are required' });
    }

    const adapter = fromName(manualMode, null, null);
    
    const commands = await adapter.applyStaticConfig({
      iface,
      address: targetAddress,
      addresses: allAddresses,
      prefix: prefixLen,
      gateway: gateway,
      dns,
      dryRun: true,
    });

    res.json({
      commands,
      adapter: adapter.constructor.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/hosts/:id/apply-ip', async (req, res) => {
  const { id } = req.params;
  const { input, iface = 'eth0', dns = [], prefix, manualMode, applyAll, addresses: directAddresses, gateway: manualGateway, dryRun } = req.body || {};
  if (!hosts.has(id)) return res.status(404).json({ error: '未找到主机' });

  try {
    let prefixLen = prefix;
    let targetAddress;
    let allAddresses;
    let gateway = manualGateway;
    let parsedHosts = [];

    // 如果直接提供了 addresses 数组（来自待应用池），优先使用
    if (directAddresses && Array.isArray(directAddresses) && directAddresses.length > 0) {
      allAddresses = applyAll ? directAddresses : [directAddresses[0]];
      targetAddress = directAddresses[0];
      if (!prefixLen) {
        return res.status(400).json({ error: '使用 addresses 参数时必须提供 prefix' });
      }
      
      // 如果没有手动提供网关，则自动计算 (通常是第一个 IP 的前一个)
      if (!gateway) {
        const ip = require('ip');
        const firstLong = ip.toLong(targetAddress);
        gateway = ip.fromLong(firstLong - 1);
      }
    } else if (input) {
      // 否则解析 input
      const parsed = parseIpInput(input);
      parsedHosts = parsed.hosts;
      
      if (parsed.mode === 'cidr') {
        prefixLen = Number(parsed.cidr.split('/')[1]);
      }
      if (!prefixLen) {
        return res.status(400).json({ error: '范围模式需要提供 prefix (子网掩码位数)' });
      }
      if (!parsed.hosts.length) {
        return res.status(400).json({ error: '没有可用主机地址' });
      }
      targetAddress = parsed.hosts[0];
      allAddresses = applyAll ? parsed.hosts : [targetAddress];
      
      if (!gateway) {
        gateway = parsed.gateway;
      }
    } else if (manualGateway || (dns && dns.length > 0)) {
      // 仅更新网关或 DNS
      const currentIps = await sshManager.listAddresses(id);
      const ifaceIps = currentIps
        .filter(i => i.iface === iface && i.family === 'inet');
      
      if (ifaceIps.length > 0) {
        allAddresses = ifaceIps.map(i => i.address.split('/')[0]);
        targetAddress = allAddresses[0];
        if (!prefixLen) {
          prefixLen = parseInt(ifaceIps[0].address.split('/')[1]) || 24;
        }
      } else {
        allAddresses = [];
        targetAddress = null;
        if (!prefixLen) prefixLen = 24;
      }
    } else {
      return res.status(400).json({ error: 'input, addresses, gateway 或 dns 必填其一' });
    }

    const adapter = await ensureAdapter(id, manualMode);
    
    const applied = await adapter.applyStaticConfig({
      iface,
      address: targetAddress,
      addresses: allAddresses,
      prefix: prefixLen,
      gateway: gateway,
      dns,
      dryRun,
    });

    if (dryRun) {
      return res.json({
        dryRun: true,
        commands: applied,
        adapter: adapter.constructor.name,
      });
    }

    res.json({
      adapter: adapter.constructor.name,
      osRelease: hosts.get(id).osRelease,
      applied: {
        address: targetAddress,
        prefix: prefixLen,
        gateway: gateway,
        dns,
      },
      availableHosts: parsedHosts,
      result: applied,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/hosts/:id/ips/:iface', async (req, res) => {
  const { id, iface } = req.params;
  const { addresses } = req.body || {}; // 获取要删除的 IP 列表

  if (!hosts.has(id)) return res.status(404).json({ error: '未找到主机' });
  try {
    const adapter = await ensureAdapter(id);
    let result;
    if (addresses && Array.isArray(addresses) && addresses.length > 0) {
      result = await adapter.removeIPs(iface, addresses);
    } else {
      result = await adapter.clearIps(iface);
    }
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/hosts/:id/ping', async (req, res) => {
  const { id } = req.params;
  const { ip, target = '8.8.8.8' } = req.body || {};
  
  if (!hosts.has(id)) return res.status(404).json({ error: '未找到主机' });
  if (!ip) return res.status(400).json({ error: 'IP 地址必填' });

  try {
    // 使用 -I 指定源 IP，-c 1 发送一次，-W 2 等待 2 秒
    // 去掉 CIDR 后缀如果存在
    const sourceIp = ip.split('/')[0];
    const cmd = `ping -I ${sourceIp} -c 1 -W 2 ${target}`;
    
    const { code, stdout } = await sshManager.exec(id, cmd, false); // false = 不在终端显示
    
    if (code === 0) {
      // 解析延迟 time=12.3 ms
      const match = stdout.match(/time=([\d.]+)\s*ms/);
      const latency = match ? match[1] : '?';
      res.json({ success: true, latency });
    } else {
      res.json({ success: false, error: 'Ping failed' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/hosts/:id/logout', (req, res) => {
  const { id } = req.params;
  if (hosts.has(id)) {
    sshManager.close(id);
    hosts.delete(id);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '主机未找到或已登出' });
  }
});

io.on('connection', (socket) => {
  socket.on('join-host', async ({ hostId }) => {
    if (!hosts.has(hostId)) {
      socket.emit('terminal:error', { message: '未找到主机' });
      return;
    }
    socket.join(hostId);
    try {
      // 注册终端输出回调，让 exec 命令的输出也显示在终端
      sshManager.registerTerminalOutput(hostId, (data) => {
        io.to(hostId).emit('terminal:data', { hostId, data });
      });
      
      await sshManager.startShell(
        hostId,
        (data) => io.to(hostId).emit('terminal:data', { hostId, data }),
        () => {
          io.to(hostId).emit('terminal:close', { hostId });
          // Shell 关闭时取消注册终端输出回调
          sshManager.unregisterTerminalOutput(hostId);
        },
      );
      socket.emit('terminal:data', { hostId, data: `已连接 ${hostId}\r\n` });
    } catch (err) {
      socket.emit('terminal:error', { message: err.message });
    }
  });

  socket.on('terminal:input', ({ hostId, data }) => {
    try {
      sshManager.writeShell(hostId, data);
    } catch (err) {
      socket.emit('terminal:error', { message: err.message });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});

