const ip = require('ip');

/**
 * Parse CIDR or range input and return gateway + host list.
 * 支持：
 *  - CIDR: 112.121.163.154/29
 *  - Range: 112.121.163.154-158 或 112.121.163.154-112.121.163.158
 */
function parseIpInput(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    throw new Error('输入不能为空');
  }

  if (trimmed.includes('/')) {
    return parseCidr(trimmed);
  }

  if (trimmed.includes('-')) {
    return parseRange(trimmed);
  }

  throw new Error('不支持的 IP 格式，请使用 CIDR 或 连续范围');
}

function parseCidr(cidr) {
  try {
    const sub = ip.cidrSubnet(cidr);
    const prefix = sub.subnetMaskLength;
    
    // 生成所有可用 IP 列表 (从 firstAddress 到 lastAddress)
    const startLong = ip.toLong(sub.firstAddress);
    const endLong = ip.toLong(sub.lastAddress);
    
    const hosts = [];
    for (let i = startLong; i <= endLong; i++) {
      hosts.push(ip.fromLong(i));
    }

    if (hosts.length === 0) {
      throw new Error('该 CIDR 范围内没有可用主机 IP');
    }

    const gateway = hosts[0];
    const usableHosts = hosts.slice(1);

    return {
      mode: 'cidr',
      cidr,
      network: sub.networkAddress,
      broadcast: sub.broadcastAddress,
      prefix,
      netmask: sub.subnetMask,
      gateway,
      hosts: usableHosts.length > 0 ? usableHosts : [gateway], // 如果只有一个可用 IP，则既是网关也是主机
    };
  } catch (err) {
    throw new Error(`CIDR 解析失败: ${err.message}`);
  }
}

function parseRange(rangeInput) {
  const [rawStart, rawEnd] = rangeInput.split('-').map((s) => s.trim());
  if (!rawEnd) {
    throw new Error('范围格式应为 start-end');
  }

  // 形如 112.121.163.154-158
  let start = rawStart;
  let end = rawEnd;
  if (!rawEnd.includes('.')) {
    const prefixParts = rawStart.split('.').slice(0, 3);
    end = `${prefixParts.join('.')}.${rawEnd}`;
  }

  if (!ip.isV4Format(start) || !ip.isV4Format(end)) {
    throw new Error(`范围 IP 无效: ${rangeInput}`);
  }

  const startLong = ip.toLong(start);
  const endLong = ip.toLong(end);
  if (endLong < startLong) {
    throw new Error('结束 IP 不能小于起始 IP');
  }

  const all = [];
  for (let i = startLong; i <= endLong; i += 1) {
    all.push(ip.fromLong(i));
  }

  if (all.length < 1) {
    throw new Error('范围内没有可用 IP');
  }

  const gateway = all[0];
  const hosts = all.slice(1);

  return {
    mode: 'range',
    range: rangeInput,
    gateway,
    hosts: hosts.length > 0 ? hosts : [gateway],
    network: null,
    broadcast: null,
    netmask: null,
  };
}

module.exports = {
  parseIpInput,
  parseCidr,
  parseRange,
};

