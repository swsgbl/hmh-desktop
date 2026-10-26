/** 本机 LAN IP(RFC1918,排除虚拟网卡)。 */
import { networkInterfaces } from 'node:os';
const VIRTUAL = /vmware|virtual|hyper-?v|vethernet|wsl|tailscale|loopback|bluetooth|vbox|docker|tap-|pseudo/i;
const isRfc1918 = (a) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
let lanIp = '';
let fallback = '';
for (const [name, list] of Object.entries(networkInterfaces())) {
  for (const n of list ?? []) {
    if (n.family !== 'IPv4' || n.internal || !isRfc1918(n.address)) continue;
    if (!VIRTUAL.test(name)) lanIp = lanIp || n.address;
    else fallback = fallback || n.address;
  }
}
console.log(JSON.stringify({ lanIp, fallback }));
