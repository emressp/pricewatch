import assert from 'node:assert/strict';
import test from 'node:test';
import { robotsDecision } from '../src/robots.js';

const RULES = `
User-agent: *
Disallow: /private
Allow: /private/public

User-agent: PricewatchBot
Disallow: /blocked
Crawl-delay: 2

User-agent: OtherBot
Disallow: /
`;

const ua = 'PricewatchBot/1.0 (+https://emressp.github.io/pricewatch/monitor/)';

test('robots.txt selects the matching agent and honors allow vs disallow', () => {
  assert.equal(robotsDecision(RULES, '/blocked', ua).allowed, false);
  assert.equal(robotsDecision(RULES, '/blocked', ua).crawlDelaySec, 2);
  assert.equal(robotsDecision(RULES, '/private', ua).allowed, true);
  assert.equal(robotsDecision(RULES, '/ok', 'SomeOther/1.0').allowed, true);
  assert.equal(robotsDecision(RULES, '/private/x', 'SomeOther/1.0').allowed, false);
  assert.equal(robotsDecision(RULES, '/private/public', 'SomeOther/1.0').allowed, true);
  assert.equal(robotsDecision('User-agent: Other\nDisallow: /\n', '/', ua).allowed, true);
  assert.equal(robotsDecision('', '/anything', ua).allowed, true);
});

test('crawl-delay is capped and an equal-length allow wins', () => {
  assert.equal(robotsDecision('User-agent: *\nCrawl-delay: 90\n', '/', ua).crawlDelaySec, 60);
  const tie = 'User-agent: *\nDisallow: /\nAllow: /\n';
  assert.equal(robotsDecision(tie, '/pricing', ua).allowed, true);
});
