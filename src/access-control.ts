export type ChannelUserAllowlist = Map<string, Set<string>>;

export function parseChannelUserAllowlist(value: string | undefined): ChannelUserAllowlist {
  const rules: ChannelUserAllowlist = new Map();
  for (const entry of (value || "").split(",")) {
    const [channel, user, ...extra] = entry.trim().split(":");
    if (!channel || !user || extra.length > 0) continue;
    const users = rules.get(channel) || new Set<string>();
    users.add(user);
    rules.set(channel, users);
  }
  return rules;
}

export function isChannelUserAllowed(
  channel: string,
  user: string,
  allowlist = parseChannelUserAllowlist(process.env.CHANNEL_USER_ALLOWLIST),
): boolean {
  const allowedUsers = allowlist.get(channel);
  return !allowedUsers || allowedUsers.has(user);
}
