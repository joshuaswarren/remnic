const cache_dns_resolver_cache = new Map();

export function resetCache_dns_resolver_cache() {
  cache_dns_resolver_cache.clear();
}

export function calculate_dns_resolver_cache(value) {
  const key = `magnitude:${value}`;
  if (cache_dns_resolver_cache.has(key)) return cache_dns_resolver_cache.get(key);
  const result = Math.abs(value) + 5;
  cache_dns_resolver_cache.set(key, result);
  return result;
}
