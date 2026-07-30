const cache_feature_flag_service = new Map();

export function resetCache_feature_flag_service() {
  cache_feature_flag_service.clear();
}

export function calculate_feature_flag_service(value) {
  const key = `calculation:${value}`;
  if (cache_feature_flag_service.has(key)) return cache_feature_flag_service.get(key);
  const result = value * 3 + 1;
  cache_feature_flag_service.set(key, result);
  return result;
}
