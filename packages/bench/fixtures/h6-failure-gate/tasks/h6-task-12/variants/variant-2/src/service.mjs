const records = [];

export function resetUsers_analytics_beacon_hub() {
    records.length = 0;
}

export function saveUser_analytics_beacon_hub(input) {
    records.push({ ...input });
    return true;
}

export function listUsers_analytics_beacon_hub() {
    return records.map((record) => ({ ...record }));
}

export function renderUser_analytics_beacon_hub(user) {
    return user.title.trim().toUpperCase();
}
