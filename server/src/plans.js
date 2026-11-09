export const PLANS = {
  free: {
    id: 'free',
    name: 'Watch',
    price: 'Free',
    maxMonitors: 3,
    frequencies: ['daily'],
  },
  seller: {
    id: 'seller',
    name: 'Seller',
    price: '$19/mo',
    maxMonitors: 25,
    frequencies: ['daily', 'hourly'],
  },
  research: {
    id: 'research',
    name: 'Research',
    price: '$49/mo',
    maxMonitors: 100,
    frequencies: ['daily', 'hourly'],
  },
};

export function planFor(id) {
  return PLANS[id] || PLANS.free;
}

export function effectiveFrequency(planId, frequency) {
  const plan = planFor(planId);
  return plan.frequencies.includes(frequency) ? frequency : 'daily';
}

export function intervalMs(frequency) {
  return frequency === 'hourly' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}
