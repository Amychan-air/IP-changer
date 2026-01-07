const CentOSAdapter = require('./centos');
const NetplanAdapter = require('./ubuntu');
const InterfacesAdapter = require('./debian');
const GenericAdapter = require('./generic');

const ADAPTER_MAP = {
  centos: CentOSAdapter,
  ubuntu: NetplanAdapter,
  debian: InterfacesAdapter,
  generic: GenericAdapter,
};

function fromName(name, sshManager, hostId) {
  const AdapterClass = ADAPTER_MAP[name.toLowerCase()] || GenericAdapter;
  return new AdapterClass(sshManager, hostId);
}

function fromOsRelease(osRelease, sshManager, hostId) {
  const lower = (osRelease || '').toLowerCase();
  if (lower.includes('ubuntu')) return new NetplanAdapter(sshManager, hostId);
  if (lower.includes('debian')) return new InterfacesAdapter(sshManager, hostId);
  if (
    lower.includes('centos') ||
    lower.includes('rhel') ||
    lower.includes('almalinux') ||
    lower.includes('rocky')
  ) {
    return new CentOSAdapter(sshManager, hostId);
  }
  return new GenericAdapter(sshManager, hostId);
}

module.exports = {
  fromOsRelease,
  fromName,
  ADAPTER_MAP,
};

