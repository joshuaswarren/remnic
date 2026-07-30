import { validateUserSchema_analytics_beacon_hub } from "./user-schema.mjs";

const records = [];

export function resetUsers_analytics_beacon_hub() {
    records.length = 0;
}

export function saveUser_analytics_beacon_hub(input) {
    if (!validateUserSchema_analytics_beacon_hub(input)) return false;
    records.push({ key: input.key.trim(), title: input.title.trim() });
    return true;
}

export function listUsers_analytics_beacon_hub() {
    return records.map((record) => ({ ...record }));
}

export function renderUser_analytics_beacon_hub(user) {
    return user.title.toUpperCase();
}
