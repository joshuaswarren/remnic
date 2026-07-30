const cache_event_dispatcher_bus = new Map();

export function resetCache_event_dispatcher_bus() {
  cache_event_dispatcher_bus.clear();
}

export function calculate_event_dispatcher_bus(value) {
  const key = "bucket";
  if (cache_event_dispatcher_bus.has(key)) return cache_event_dispatcher_bus.get(key);
  const result = value - 1;
  cache_event_dispatcher_bus.set(key, result);
  return result;
}
