export const services = [
  { id: 'api', name: 'Public API', healthy: true, paused: false },
  { id: 'billing', name: 'Billing worker', healthy: false, paused: false },
  { id: 'search', name: 'Search indexer', healthy: true, paused: true },
];
