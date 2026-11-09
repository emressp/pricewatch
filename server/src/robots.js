function startGroup(groups) {
  const group = { agents: [], rules: [], crawlDelaySec: 0, locked: false };
  groups.push(group);
  return group;
}

export function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.locked) current = startGroup(groups);
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (key !== 'allow' && key !== 'disallow' && key !== 'crawl-delay') continue;
    if (!current) current = startGroup(groups);
    current.locked = true;
    if (key === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelaySec = Math.min(delay, 60);
      continue;
    }
    if (!value && key === 'disallow') continue;
    if (!value) continue;
    current.rules.push({ allow: key === 'allow', path: value });
  }
  return { groups: groups.filter((group) => group.agents.length) };
}

function agentMatches(ruleAgent, userAgent) {
  const rule = ruleAgent.toLowerCase();
  if (rule === '*') return true;
  const product = String(userAgent || '').split(/[\s/]/)[0].toLowerCase();
  if (!product) return false;
  return product.startsWith(rule) || rule.startsWith(product);
}

export function selectGroup(groups, userAgent) {
  let best = null;
  let bestLength = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*') continue;
      if (agentMatches(agent, userAgent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }
  if (best) return best;
  return groups.find((group) => group.agents.includes('*')) || null;
}

function ruleMatchLength(pattern, path) {
  if (!pattern) return -1;
  const anchored = pattern.endsWith('$');
  const core = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = core.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const source = `^${escaped}${anchored ? '$' : ''}`;
  if (!new RegExp(source).test(path)) return -1;
  return pattern.length;
}

export function pathAllowed(rules, path) {
  let allowed = true;
  let bestLength = -1;
  for (const rule of rules) {
    const length = ruleMatchLength(rule.path, path);
    if (length < 0) continue;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      bestLength = length;
      allowed = rule.allow;
    }
  }
  return allowed;
}

export function robotsDecision(robotsText, urlPath, userAgent) {
  const parsed = typeof robotsText === 'string' || robotsText == null ? parseRobots(robotsText || '') : robotsText;
  const group = selectGroup(parsed.groups || [], userAgent);
  const path = urlPath && String(urlPath).startsWith('/') ? String(urlPath) : `/${urlPath || ''}`;
  if (!group) return { allowed: true, crawlDelaySec: 0 };
  return {
    allowed: pathAllowed(group.rules, path),
    crawlDelaySec: group.crawlDelaySec || 0,
  };
}
