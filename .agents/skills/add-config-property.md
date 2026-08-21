# Skill: Add a Config Property

Step-by-step guide for safely adding a new configuration property to openclaw-engram.

## Steps

### 1. Add to the config interface

In `src/config.ts`, add the property with its type and default value:

```typescript
export interface EngramConfig {
  // ... existing properties ...
  myNewProperty: boolean;  // Add here
}

export function parseConfig(raw: unknown): EngramConfig {
  // ... existing code ...
  return {
    // ... existing mappings ...
    myNewProperty: raw?.myNewProperty ?? false,  // Add default here
  };
}
```

### 2. Add to the plugin manifest

In `openclaw.plugin.json`, add to `configSchema.properties`:

```json
"myNewProperty": {
  "type": "boolean",
  "default": false,
  "description": "Brief description of what this property controls."
}
```

### 3. Verify alignment

```bash
npm run check-config-contract
```

This must pass without errors. If it fails, the interface and manifest are out of sync.

### 4. Document it

Add an entry to `docs/config-reference.md` in the appropriate section.

### 5. Test it

Add a test case in `tests/` that covers:
- Default value behavior (when property is omitted from config)
- Non-default value behavior
- Invalid value handling (if applicable)

## Notes

- Config is the plugin's public API — once released, maintain backward compatibility.
- `enabled=false` and `0` limits are hard contracts — never coerce them.
- Run `npm run preflight` before submitting the PR.
