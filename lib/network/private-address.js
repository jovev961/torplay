import net from "node:net";

export function isPrivateNetworkAddress(value) {
  let address = String(value || "").trim().split("%")[0].toLowerCase();
  if (address.startsWith("::ffff:")) address = address.slice(7);

  if (net.isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }

  if (net.isIP(address) !== 6) return false;
  return address === "::1"
    || address.startsWith("fc")
    || address.startsWith("fd")
    || /^fe[89ab]/.test(address);
}
