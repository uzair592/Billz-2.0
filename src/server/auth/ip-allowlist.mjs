import { BlockList, isIP } from "node:net";
export function createIpAllowlist(raw) {
  if (!String(raw || "").trim()) return null;
  const list = new BlockList();
  for (const value of raw.split(",").map((value) => value.trim())) {
    const [ip, prefix, extra] = value.split("/");
    const version = isIP(ip);
    if (
      !version ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > (version === 4 ? 32 : 128)))
    ) {
      throw Object.assign(
        new Error(
          "PLATFORM_ADMIN_ALLOWED_IPS must list valid IPs or specific CIDRs.",
        ),
        { code: "CONFIGURATION_INVALID" },
      );
    }
    const type = version === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(ip, type);
    else list.addSubnet(ip, Number(prefix), type);
  }
  return (address) => {
    const ip =
      address.startsWith("::ffff:") && isIP(address.slice(7)) === 4
        ? address.slice(7)
        : address;
    return Boolean(
      isIP(ip) && list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6"),
    );
  };
}
