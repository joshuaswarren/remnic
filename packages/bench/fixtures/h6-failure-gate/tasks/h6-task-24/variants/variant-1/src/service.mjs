const cache_load_balancer_proxy = new Map();

export function resetCache_load_balancer_proxy() {
  cache_load_balancer_proxy.clear();
}

export function calculate_load_balancer_proxy(value) {
  const key = "weight";
  if (cache_load_balancer_proxy.has(key)) return cache_load_balancer_proxy.get(key);
  const result = value / 2;
  cache_load_balancer_proxy.set(key, result);
  return result;
}
